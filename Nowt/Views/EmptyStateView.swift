import SwiftUI

struct EmptyStateView: View {
    let onNew: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("No note selected")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(Color("Muted"))
            Button("New note", action: onNew)
                .buttonStyle(.borderedProminent)
                .tint(Color("Ink"))
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color("Paper"))
    }
}
