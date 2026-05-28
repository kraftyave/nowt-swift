import SwiftUI
import SwiftData

struct RootView: View {
    @Environment(\.modelContext) private var context
    @Query(sort: \Note.updatedAt, order: .reverse)
    private var allNotes: [Note]

    @State private var selectedNote: Note?
    @State private var filter: NoteFilter = .notes

    var visibleNotes: [Note] {
        let filtered: [Note]
        switch filter {
        case .notes:    filtered = allNotes.filter { $0.status == "active" }
        case .archive:  filtered = allNotes.filter { $0.status == "archived" }
        case .trash:    filtered = allNotes.filter { $0.status == "deleted" }
        }
        // Pinned notes first, then by updatedAt desc (already sorted by query)
        return filtered.sorted { $0.pinned && !$1.pinned }
    }

    var body: some View {
        NavigationSplitView {
            NoteListView(
                notes: visibleNotes,
                selectedNote: $selectedNote,
                filter: $filter,
                onNew: createNote,
                onDelete: delete,
                onArchive: archive,
                onRestore: restore
            )
#if os(macOS)
            .navigationSplitViewColumnWidth(min: 200, ideal: 240, max: 320)
#endif
        } detail: {
            if let note = selectedNote {
                NoteDetailView(note: note)
            } else {
                EmptyStateView(onNew: createNote)
            }
        }
#if os(macOS)
        .navigationSplitViewStyle(.balanced)
#endif
    }

    private func createNote() {
        let note = Note()
        context.insert(note)
        try? context.save()
        selectedNote = note
    }

    private func delete(_ note: Note) {
        note.status = "deleted"
        note.deletedAt = .now
        if selectedNote?.id == note.id { selectedNote = nil }
        try? context.save()
    }

    private func archive(_ note: Note) {
        note.status = "archived"
        note.updatedAt = .now
        if selectedNote?.id == note.id { selectedNote = nil }
        try? context.save()
    }

    private func restore(_ note: Note) {
        note.status = "active"
        note.deletedAt = nil
        note.updatedAt = .now
        try? context.save()
    }
}

enum NoteFilter: String, CaseIterable {
    case notes, archive, trash
    var label: String { rawValue.capitalized }
}
