import SwiftUI

struct NoteDetailView: View {
    @Bindable var note: Note
    @State private var activeTabId: String = ""
    @Environment(\.modelContext) private var context

    private var sortedTabs: [Tab] {
        note.tabs.sorted { $0.sortOrder < $1.sortOrder }
    }

    private var activeTab: Tab? {
        note.tabs.first(where: { $0.id == activeTabId }) ?? note.tabs.first
    }

    var body: some View {
        VStack(spacing: 0) {
            if note.tabs.count > 1 || true { // always show tab strip
                tabStrip
            }
            if let tab = activeTab {
                NoteEditorView(note: note, tab: tab)
            }
        }
        .background(Color("Paper"))
        .onAppear { activeTabId = note.activeTabId }
        .onChange(of: note.id) { activeTabId = note.activeTabId }
        .toolbar { toolbarContent }
    }

    // MARK: Tab strip

    private var tabStrip: some View {
        HStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(sortedTabs) { tab in
                        tabButton(tab)
                    }
                    addTabButton
                }
                .padding(.horizontal, 18)
            }

            // Layout toggle placeholder (vtabs/htabs)
            Button {
                // toggle tab layout — next session
            } label: {
                Image(systemName: "sidebar.right")
                    .font(.system(size: 13))
                    .foregroundStyle(Color("Muted"))
            }
            .buttonStyle(.plain)
            .padding(.horizontal, 16)
            .frame(maxHeight: .infinity)
            .overlay(alignment: .leading) {
                Rectangle().fill(Color("Rule")).frame(width: 1)
            }
        }
        .frame(height: 40)
        .background(Color("Paper"))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color("Rule")).frame(height: 1)
        }
    }

    private func tabButton(_ tab: Tab) -> some View {
        HStack(spacing: 4) {
            Text(tab.displayTitle)
                .lineLimit(1)
            Button {
                removeTab(tab)
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundStyle(Color("Muted"))
            }
            .buttonStyle(.plain)
            .help("Close tab")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 9)
        .background(activeTabId == tab.id ? Color("Ink") : Color.clear)
        .foregroundStyle(activeTabId == tab.id ? Color("Paper") : Color("Muted"))
        .contentShape(Rectangle())
        .onTapGesture {
            activeTabId = tab.id
            note.activeTabId = tab.id
        }
    }

    private func removeTab(_ tab: Tab) {
        guard note.tabs.count > 1 else { return }
        let index = note.tabs.firstIndex(where: { $0.id == tab.id }) ?? 0
        note.tabs.remove(at: index)
        if activeTabId == tab.id {
            let newActive = note.tabs[safe: max(0, index - 1)]
            activeTabId = newActive?.id ?? ""
            note.activeTabId = activeTabId
        }
        note.updatedAt = .now
    }

    private var addTabButton: some View {
        Button("+") { addTab() }
            .font(.dmSans(12, weight: .medium))
            .foregroundStyle(Color("Muted"))
            .padding(.horizontal, 12)
            .padding(.vertical, 9)
            .contentShape(Rectangle())
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
        ToolbarItem(placement: .primaryAction) {
            Menu {
                Button("Archive") {
                    note.status = "archived"
                    note.updatedAt = .now
                }
                Button("Delete", role: .destructive) {
                    note.status = "deleted"
                    note.deletedAt = .now
                }
            } label: {
                Image(systemName: "ellipsis")
            }
        }
    }

    // MARK: Actions

    private func addTab() {
        let order = (note.tabs.map(\.sortOrder).max() ?? 0) + 1
        let tab = Tab(sortOrder: order)
        note.tabs.append(tab)
        activeTabId = tab.id
        note.activeTabId = tab.id
        note.updatedAt = .now
    }
}

extension Array {
    subscript(safe index: Int) -> Element? {
        indices.contains(index) ? self[index] : nil
    }
}
