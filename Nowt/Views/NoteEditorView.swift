import SwiftUI

struct NoteEditorView: View {
    @Bindable var note: Note
    @Bindable var tab: Tab

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                // Title
                MultilineTextField(
                    text: $note.title,
                    placeholder: "Untitled note",
                    font: .custom("SpaceGrotesk-Bold", size: 28),
                    onCommit: {}
                )
                .foregroundStyle(Color("Ink"))
                .padding(.horizontal, 24)
                .padding(.top, 24)
                .padding(.bottom, 16)
                .onChange(of: note.title) { note.updatedAt = .now }

                Rectangle()
                    .fill(Color("Rule"))
                    .frame(height: 1)
                    .padding(.horizontal, 24)

                // Body
                MultilineTextField(
                    text: $tab.content,
                    placeholder: "Start writing…",
                    font: .custom("DMSans-Regular", size: 15),
                    onCommit: {}
                )
                .foregroundStyle(Color("Ink"))
                .padding(24)
                .onChange(of: tab.content) { note.updatedAt = .now }

                Spacer(minLength: 80)
            }
        }
        .background(Color("Paper"))
    }
}

// MARK: - Cross-platform multiline text field

#if os(macOS)
import AppKit

struct MultilineTextField: NSViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var font: NSFont?
    var onCommit: () -> Void

    init(text: Binding<String>, placeholder: String, font: Font, onCommit: @escaping () -> Void) {
        self._text = text
        self.placeholder = placeholder
        self.onCommit = onCommit

        // Resolve SwiftUI Font → NSFont
        if case .custom(let name, let size, _) = font.provider {
            self.font = NSFont(name: name, size: size)
        }
    }

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSTextView.scrollableTextView()
        let tv = scrollView.documentView as! NSTextView
        tv.delegate = context.coordinator
        tv.isRichText = false
        tv.isEditable = true
        tv.isSelectable = true
        tv.drawsBackground = false
        tv.textContainerInset = .zero
        tv.textContainer?.lineFragmentPadding = 0
        tv.font = font ?? NSFont.systemFont(ofSize: 15)
        tv.textColor = NSColor(named: "Ink")
        tv.insertionPointColor = NSColor(named: "Ink") ?? .black
        scrollView.hasVerticalScroller = false
        scrollView.hasHorizontalScroller = false
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        return scrollView
    }

    func updateNSView(_ scrollView: NSScrollView, context: Context) {
        let tv = scrollView.documentView as! NSTextView
        if tv.string != text {
            let sel = tv.selectedRanges
            tv.string = text
            tv.selectedRanges = sel
        }
        tv.font = font ?? NSFont.systemFont(ofSize: 15)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator: NSObject, NSTextViewDelegate {
        var parent: MultilineTextField
        init(_ parent: MultilineTextField) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard let tv = notification.object as? NSTextView else { return }
            parent.text = tv.string
        }
    }
}

// Font provider introspection helper for macOS
private extension Font {
    enum Provider {
        case custom(String, CGFloat, Font.TextStyle?)
        case other
    }
    var provider: Provider {
        let mirror = Mirror(reflecting: self)
        for child in mirror.children {
            let childMirror = Mirror(reflecting: child.value)
            for grandchild in childMirror.children {
                if grandchild.label == "name", let name = grandchild.value as? String {
                    for sibling in childMirror.children {
                        if sibling.label == "size", let size = sibling.value as? CGFloat {
                            return .custom(name, size, nil)
                        }
                    }
                }
            }
        }
        return .other
    }
}

#else
import UIKit

struct MultilineTextField: UIViewRepresentable {
    @Binding var text: String
    var placeholder: String
    var font: UIFont?
    var onCommit: () -> Void

    init(text: Binding<String>, placeholder: String, font: Font, onCommit: @escaping () -> Void) {
        self._text = text
        self.placeholder = placeholder
        self.onCommit = onCommit

        if case .custom(let name, let size, _) = font.provider {
            self.font = UIFont(name: name, size: size)
        }
    }

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.delegate = context.coordinator
        tv.isScrollEnabled = false
        tv.backgroundColor = .clear
        tv.font = font ?? .systemFont(ofSize: 15)
        tv.textColor = UIColor(named: "Ink")
        tv.textContainerInset = .zero
        tv.textContainer.lineFragmentPadding = 0
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if tv.text != text { tv.text = text }
        tv.font = font ?? .systemFont(ofSize: 15)
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    class Coordinator: NSObject, UITextViewDelegate {
        var parent: MultilineTextField
        init(_ parent: MultilineTextField) { self.parent = parent }
        func textViewDidChange(_ tv: UITextView) { parent.text = tv.text }
    }
}

private extension Font {
    enum Provider {
        case custom(String, CGFloat, Font.TextStyle?)
        case other
    }
    var provider: Provider {
        let mirror = Mirror(reflecting: self)
        for child in mirror.children {
            let childMirror = Mirror(reflecting: child.value)
            for grandchild in childMirror.children {
                if grandchild.label == "name", let name = grandchild.value as? String {
                    for sibling in childMirror.children {
                        if sibling.label == "size", let size = sibling.value as? CGFloat {
                            return .custom(name, size, nil)
                        }
                    }
                }
            }
        }
        return .other
    }
}
#endif
