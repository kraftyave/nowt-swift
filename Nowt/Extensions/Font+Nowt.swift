import SwiftUI

extension Font {
    // DM Sans — body text
    static func dmSans(_ size: CGFloat, weight: Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .bold, .heavy, .black: name = "DMSans-Bold"
        case .medium, .semibold:    name = "DMSans-Medium"
        default:                    name = "DMSans-Regular"
        }
        return .custom(name, size: size)
    }

    // Space Grotesk — headings
    static func spaceGrotesk(_ size: CGFloat, weight: Weight = .medium) -> Font {
        let name: String
        switch weight {
        case .bold, .heavy, .black: name = "SpaceGrotesk-Bold"
        case .semibold:             name = "SpaceGrotesk-SemiBold"
        default:                    name = "SpaceGrotesk-Medium"
        }
        return .custom(name, size: size)
    }
}
