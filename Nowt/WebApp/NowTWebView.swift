import SwiftUI
import WebKit
import UniformTypeIdentifiers

// MARK: - SwiftUI wrapper

struct NowTWebView: View {
    var body: some View {
        ZStack(alignment: .top) {
            WebViewRepresentable()
                .ignoresSafeArea()

            #if os(macOS)
            WindowDragHandle()
                .frame(height: 30)
            #endif
        }
    }
}

#if os(macOS)
/// Invisible drag area at the top of the window so users can move the
/// app even with `.hiddenTitleBar` — the WKWebView consumes all mouse
/// events, so we need a native view overlay that forwards drags to the window.
struct WindowDragHandle: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = DraggableRegion()
        view.wantsLayer = true
        view.layer?.backgroundColor = .clear
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {}
}

private class DraggableRegion: NSView {
    override func mouseDown(with event: NSEvent) {
        window?.performDrag(with: event)
    }
    override func mouseDragged(with event: NSEvent) {
        window?.performDrag(with: event)
    }
}
#endif

// MARK: - Platform representable

#if os(macOS)

struct WebViewRepresentable: NSViewRepresentable {
    func makeNSView(context: Context) -> WKWebView {
        let wv = makeWebView(coordinator: context.coordinator)
        context.coordinator.webView = wv
        loadApp(wv)
        return wv
    }
    func updateNSView(_ wv: WKWebView, context: Context) {}
    func makeCoordinator() -> WebCoordinator { WebCoordinator() }
}

#else

struct WebViewRepresentable: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let wv = makeWebView(coordinator: context.coordinator)
        context.coordinator.webView = wv
        loadApp(wv)
        return wv
    }
    func updateUIView(_ wv: WKWebView, context: Context) {}
    func makeCoordinator() -> WebCoordinator { WebCoordinator() }
}

#endif

// MARK: - Shared factory

@MainActor
private func makeWebView(coordinator: WebCoordinator) -> WKWebView {
    let config = WKWebViewConfiguration()

    // Allow localStorage and IndexedDB to persist across app launches
    config.websiteDataStore = .default()

    // Allow media (voice recording)
    config.mediaTypesRequiringUserActionForPlayback = []
#if os(iOS)
    config.allowsInlineMediaPlayback = true
#endif

    // JS bridge handlers
    let contentController = config.userContentController
    contentController.add(coordinator, name: "nowt_fs")
    contentController.add(coordinator, name: "nowt_open")
    contentController.add(coordinator, name: "nowt_log")

    // Inject nowtNative before any page JS runs
    let bridgeScript = WKUserScript(
        source: nowtNativeBridgeJS,
        injectionTime: .atDocumentStart,
        forMainFrameOnly: true
    )
    contentController.addUserScript(bridgeScript)

    let wv = WKWebView(frame: .zero, configuration: config)
    wv.navigationDelegate = coordinator
    wv.uiDelegate = coordinator

#if os(macOS)
    wv.setValue(false, forKey: "drawsBackground")
#else
    wv.isOpaque = false
    wv.backgroundColor = .clear
    wv.scrollView.bounces = false
#endif

    return wv
}

@MainActor
private func loadApp(_ wv: WKWebView) {
    guard let indexURL = Bundle.main.url(forResource: "index", withExtension: "html") else {
        print("NowT: index.html not found in bundle — check WebApp folder is included as a resource")
        return
    }
    let baseURL = indexURL.deletingLastPathComponent()
    let folderPath = resolveNowTFolder().path
    var components = URLComponents(url: indexURL, resolvingAgainstBaseURL: false)!
    components.queryItems = [URLQueryItem(name: "desktopFolder", value: folderPath)]
    wv.loadFileURL(components.url ?? indexURL, allowingReadAccessTo: baseURL)
}

private func resolveNowTFolder() -> URL {
    let fm = FileManager.default
    let home = fm.homeDirectoryForCurrentUser
    let iCloudBase = home.appendingPathComponent("Library/Mobile Documents/com~apple~CloudDocs")
    let folder: URL
    if fm.fileExists(atPath: iCloudBase.path) {
        folder = iCloudBase.appendingPathComponent("Nowt")
    } else {
        folder = fm.urls(for: .documentDirectory, in: .userDomainMask).first!
            .appendingPathComponent("Nowt")
    }
    try? fm.createDirectory(at: folder, withIntermediateDirectories: true)
    return folder
}

// MARK: - Native bridge JS (injected before page runs)

private let nowtNativeBridgeJS = """
window.nowtNative = {
  platform: "swiftui",

  // File system ops — async via Swift message handler
  // Returns a Promise that resolves when Swift replies
  readFile: function(path) {
    return window.__nowtCall("fs_read", { path: path });
  },
  writeFile: function(path, data) {
    return window.__nowtCall("fs_write", { path: path, data: data });
  },
  readBinary: function(path) {
    return window.__nowtCall("fs_read_binary", { path: path });
  },
  writeBinary: function(path, base64) {
    return window.__nowtCall("fs_write_binary", { path: path, data: base64 });
  },
  exists: function(path) {
    return window.__nowtCall("fs_exists", { path: path });
  },
  ensureDir: function(path) {
    return window.__nowtCall("fs_ensure_dir", { path: path });
  },
  pickPhoto: function() {
    return window.__nowtCall("fs_pick_photo", {});
  },
  openCheckout: function(url) {
    window.webkit.messageHandlers.nowt_open.postMessage({ url: url });
    return Promise.resolve({ success: true });
  },
  onMenu: function(callback) {
    window.__nowtMenuCallback = callback;
  }
};

// Promise bridge for async Swift calls
window.__nowtPending = {};
window.__nowtCallId = 0;
window.__nowtCall = function(op, args) {
  return new Promise(function(resolve, reject) {
    var id = ++window.__nowtCallId;
    window.__nowtPending[id] = { resolve: resolve, reject: reject };
    window.webkit.messageHandlers.nowt_fs.postMessage({ id: id, op: op, args: args });
  });
};

// Swift calls this to resolve a pending promise
window.__nowtResolve = function(id, result) {
  var p = window.__nowtPending[id];
  if (p) { p.resolve(result); delete window.__nowtPending[id]; }
};
window.__nowtReject = function(id, err) {
  var p = window.__nowtPending[id];
  if (p) { p.reject(new Error(err)); delete window.__nowtPending[id]; }
};

// Swift calls this to trigger menu actions
window.__nowtMenu = function(action) {
  if (window.__nowtMenuCallback) window.__nowtMenuCallback(action);
};

console.log("[NowT] nowtNative bridge injected, platform=swiftui");
"""

// MARK: - Coordinator (handles JS → Swift messages)

final class WebCoordinator: NSObject,
    WKNavigationDelegate,
    WKUIDelegate,
    WKScriptMessageHandler
{
    weak var webView: WKWebView?
    nonisolated(unsafe) private var menuObserver: NSObjectProtocol?

    override init() {
        super.init()
        menuObserver = NotificationCenter.default.addObserver(
            forName: .nowtMenu, object: nil, queue: .main
        ) { [weak self] note in
            guard let action = note.object as? String else { return }
            Task { @MainActor in
                _ = try? await self?.webView?.evaluateJavaScript("window.__nowtMenu('\(action)')")
            }
        }
    }

    deinit {
        if let obs = menuObserver {
            NotificationCenter.default.removeObserver(obs)
        }
    }

    func userContentController(_ ucc: WKUserContentController,
                                didReceive message: WKScriptMessage) {
        switch message.name {
        case "nowt_log":
            print("[NowT-JS]", message.body)

        case "nowt_open":
            guard let body = message.body as? [String: Any],
                  let urlStr = body["url"] as? String,
                  let url = URL(string: urlStr) else { return }
#if os(macOS)
            NSWorkspace.shared.open(url)
#else
            UIApplication.shared.open(url)
#endif

        case "nowt_fs":
            handleFS(message)

        default:
            break
        }
    }

    private func handleFS(_ message: WKScriptMessage) {
        guard let body = message.body as? [String: Any],
              let callId = body["id"] as? Int,
              let op = body["op"] as? String,
              let args = body["args"] as? [String: Any] else { return }

        let path = args["path"] as? String ?? ""

        Task {
            do {
                let result = try await dispatchFS(op: op, path: path, args: args)
                await MainActor.run { resolve(callId, result: result) }
            } catch {
                await MainActor.run { reject(callId, error: error.localizedDescription) }
            }
        }
    }

    private func dispatchFS(op: String, path: String, args: [String: Any]) async throws -> Any {
        let url = URL(fileURLWithPath: path)
        switch op {
        case "fs_read":
            guard FileManager.default.fileExists(atPath: path) else { return NSNull() }
            let str = try String(contentsOf: url, encoding: .utf8)
            return str

        case "fs_write":
            let data = args["data"] as? String ?? ""
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, atomically: true, encoding: .utf8)
            return true

        case "fs_exists":
            return FileManager.default.fileExists(atPath: path)

        case "fs_ensure_dir":
            try FileManager.default.createDirectory(
                at: url, withIntermediateDirectories: true)
            return true

        case "fs_read_binary":
            guard FileManager.default.fileExists(atPath: path) else { return NSNull() }
            let data = try Data(contentsOf: url)
            return data.base64EncodedString()

        case "fs_write_binary":
            let b64 = args["data"] as? String ?? ""
            guard let data = Data(base64Encoded: b64) else { return false }
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url)
            return true

#if os(macOS)
        case "fs_pick_photo":
            return try await withCheckedThrowingContinuation { continuation in
                Task { @MainActor in
                    let panel = NSOpenPanel()
                    panel.canChooseFiles = true
                    panel.canChooseDirectories = false
                    panel.allowsMultipleSelection = false
                    panel.allowedContentTypes = [.image]
                    panel.begin { response in
                        guard response == .OK, let fileURL = panel.url else {
                            continuation.resume(returning: NSNull())
                            return
                        }
                        do {
                            let data = try Data(contentsOf: fileURL)
                            let mime = UTType(filenameExtension: fileURL.pathExtension)?.preferredMIMEType ?? "image/jpeg"
                            continuation.resume(returning: [
                                "name": fileURL.lastPathComponent,
                                "type": mime,
                                "data": data.base64EncodedString()
                            ] as [String: Any])
                        } catch {
                            continuation.resume(throwing: error)
                        }
                    }
                }
            }
#endif

        default:
            throw NSError(domain: "NowT", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Unknown op: \(op)"])
        }
    }

    @MainActor
    private func resolve(_ id: Int, result: Any) {
        let json = jsLiteral(from: result)
        webView?.evaluateJavaScript("window.__nowtResolve(\(id), \(json))", completionHandler: nil)
    }

    @MainActor
    private func reject(_ id: Int, error: String) {
        webView?.evaluateJavaScript("window.__nowtReject(\(id), \(jsLiteral(from: error)))", completionHandler: nil)
    }

    private func jsLiteral(from value: Any) -> String {
        let data: Data?
        switch value {
        case let string as String:
            data = try? JSONEncoder().encode(string)
        case let bool as Bool:
            data = try? JSONEncoder().encode(bool)
        case let dict as [String: Any] where JSONSerialization.isValidJSONObject(dict):
            data = try? JSONSerialization.data(withJSONObject: dict)
        case let array as [Any] where JSONSerialization.isValidJSONObject(array):
            data = try? JSONSerialization.data(withJSONObject: array)
        default:
            data = nil
        }

        guard let data,
              let json = String(data: data, encoding: .utf8) else {
            return "null"
        }
        return json
    }

    // JavaScript dialog handlers — required to prevent WebContent process crashes on macOS
    #if os(macOS)
    func webView(_ webView: WKWebView,
                 runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        guard let window = webView.window else { return }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in }
    }

    func webView(_ webView: WKWebView,
                 runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        guard let window = webView.window else { return false }
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        return await withCheckedContinuation { continuation in
            alert.beginSheetModal(for: window) { response in
                continuation.resume(returning: response == .alertFirstButtonReturn)
            }
        }
    }
    #endif

    // Microphone permission for voice recording
    @MainActor
    func webView(_ webView: WKWebView,
                 requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType,
                 decisionHandler: @escaping @MainActor @Sendable (WKPermissionDecision) -> Void) {
        decisionHandler(.grant)
    }

#if os(macOS)
    // File picker for photo/file upload inputs
    @MainActor
    func webView(_ webView: WKWebView,
                 runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo,
                 completionHandler: @escaping @MainActor @Sendable ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.allowedContentTypes = [.image, .movie, .audio, .data]
        panel.begin { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }
#endif

    // Allow file:// → file:// navigation (needed for local resources)
    @MainActor
    func webView(_ webView: WKWebView,
                 decidePolicyFor action: WKNavigationAction,
                 decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void) {
        decisionHandler(.allow)
    }

    // Open external links in system browser
    func webView(_ webView: WKWebView,
                 createWebViewWith config: WKWebViewConfiguration,
                 for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "https" || url.scheme == "http" {
#if os(macOS)
            NSWorkspace.shared.open(url)
#else
            UIApplication.shared.open(url)
#endif
        }
        return nil
    }
}
