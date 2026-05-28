import Foundation
import SwiftData

@Model
final class Tab {
    var id: String
    var title: String
    var titleTouched: Bool
    var content: String      // rich text as HTML string (mirrors inlineContent)
    var lineSpacing: String  // "normal" | "relaxed" | "loose"
    var sortOrder: Int

    init(id: String = UUID().uuidString, title: String = "", sortOrder: Int = 0) {
        self.id = id
        self.title = title
        self.titleTouched = false
        self.content = ""
        self.lineSpacing = "normal"
        self.sortOrder = sortOrder
    }

    var displayTitle: String {
        titleTouched && !title.isEmpty ? title : "Tab"
    }
}
