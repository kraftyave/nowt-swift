import SwiftUI

@main
struct NowTApp: App {
    var body: some Scene {
        WindowGroup {
            NowTWebView()
                .background(Color.black)
#if os(macOS)
                .frame(minWidth: 700, minHeight: 480)
#endif
        }
#if os(macOS)
        .windowStyle(.hiddenTitleBar)
        .defaultSize(width: 960, height: 640)
        .windowResizability(.contentMinSize)
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Note") {
                    NotificationCenter.default.post(name: .nowtMenu, object: "new-note")
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            CommandGroup(after: .newItem) {
                Button("Search") {
                    NotificationCenter.default.post(name: .nowtMenu, object: "search")
                }
                .keyboardShortcut("k", modifiers: .command)
                Button("Settings") {
                    NotificationCenter.default.post(name: .nowtMenu, object: "settings")
                }
                .keyboardShortcut(",", modifiers: .command)
            }
        }
#endif
#if os(macOS)
        MenuBarExtra {
            Button("New Note") {
                NotificationCenter.default.post(name: .nowtMenu, object: "new-note")
            }
            .keyboardShortcut("n", modifiers: .command)
            Button("Search") {
                NotificationCenter.default.post(name: .nowtMenu, object: "search")
            }
            .keyboardShortcut("k", modifiers: .command)
            Divider()
            Button("Settings") {
                NotificationCenter.default.post(name: .nowtMenu, object: "settings")
            }
            .keyboardShortcut(",", modifiers: .command)
        } label: {
            Image("TrayIcon")
                .resizable()
                .renderingMode(.original)
                .frame(width: 16, height: 16)
        }
#endif
    }
}

extension Notification.Name {
    static let nowtMenu = Notification.Name("nowtMenu")
}
