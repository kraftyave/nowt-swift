import SwiftUI

// Filter tabs: Notes / Archive / Trash at top of sidebar
struct FilterTabStyle: ButtonStyle {
    let isActive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.dmSans(12, weight: .medium))
            .foregroundStyle(isActive ? Color("Paper") : Color("InkSoft"))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(isActive ? Color("Ink") : Color.clear)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed && !isActive ? 0.7 : 1)
    }
}

// Tab strip buttons inside the note editor
struct TabButtonStyle: ButtonStyle {
    let isActive: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.dmSans(12, weight: .medium))
            .foregroundStyle(isActive ? Color("Paper") : Color("Muted"))
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .background(isActive ? Color("Ink") : Color.clear)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed && !isActive ? 0.7 : 1)
    }
}

// Ghost toolbar button (search, settings, etc.)
struct GhostButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.dmSans(13))
            .foregroundStyle(Color("Ink"))
            .padding(8)
            .background(configuration.isPressed
                ? Color("Ink").opacity(0.07)
                : Color.clear)
            .contentShape(Rectangle())
    }
}
