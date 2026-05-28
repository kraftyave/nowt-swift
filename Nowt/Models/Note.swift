import Foundation
import SwiftData

@Model
final class Note {
    var id: String
    var title: String
    var status: String      // "active" | "archived" | "deleted"
    var pinned: Bool
    var createdAt: Date
    var updatedAt: Date
    var deletedAt: Date?
    var activeTabId: String
    @Relationship(deleteRule: .cascade) var tabs: [Tab]

    init(title: String = "Untitled note") {
        let tabId = UUID().uuidString
        self.id = UUID().uuidString
        self.title = title
        self.status = "active"
        self.pinned = false
        self.createdAt = .now
        self.updatedAt = .now
        self.deletedAt = nil
        self.activeTabId = tabId
        self.tabs = [Tab(id: tabId)]
    }

    var activeTab: Tab? {
        tabs.first(where: { $0.id == activeTabId }) ?? tabs.first
    }

    var isDeleted: Bool { status == "deleted" }
    var isArchived: Bool { status == "archived" }
}
