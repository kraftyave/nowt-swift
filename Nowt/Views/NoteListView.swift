import SwiftUI

struct NoteListView: View {
    let notes: [Note]
    @Binding var selectedNote: Note?
    @Binding var filter: NoteFilter
    let onNew: () -> Void
    let onDelete: (Note) -> Void
    let onArchive: (Note) -> Void
    let onRestore: (Note) -> Void

    var body: some View {
        VStack(spacing: 0) {
            filterBar

            if notes.isEmpty {
                emptyList
            } else {
                List(notes, selection: $selectedNote) { note in
                    NoteRowView(note: note)
                        .tag(note)
                        .contentShape(Rectangle())
                        .contextMenu {
                            contextMenuContent(for: note)
                        }
                        .listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 0, trailing: 16))
                        .listRowBackground(Color.clear)
                        .listRowSeparatorTint(Color("Rule"))
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .background(Color("Paper"))
            }

            footer
        }
        .background(Color("Paper"))
        .toolbar { toolbarContent }
    }

    // MARK: Filter bar

    private var filterBar: some View {
        HStack(spacing: 0) {
            ForEach(NoteFilter.allCases, id: \.self) { f in
                Button(f.label) {
                    withAnimation(.easeInOut(duration: 0.1)) { filter = f }
                }
                .buttonStyle(FilterTabStyle(isActive: filter == f))
                .frame(maxWidth: .infinity)
            }
        }
        .frame(height: 36)
        .background(Color("Paper"))
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color("Rule")).frame(height: 1)
        }
    }

    // MARK: Empty list

    private var emptyList: some View {
        VStack {
            Spacer()
            Text(filter == .trash ? "Trash is empty" : filter == .archive ? "Nothing archived" : "No notes yet")
                .font(.dmSans(13))
                .foregroundStyle(Color("Muted"))
            Spacer()
        }
        .frame(maxWidth: .infinity)
        .background(Color("Paper"))
    }

    // MARK: Footer

    private var footer: some View {
        HStack {
            Text("\(notes.count) \(notes.count == 1 ? "note" : "notes")")
                .font(.dmSans(11))
                .foregroundStyle(Color("Muted"))
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Color("Paper"))
        .overlay(alignment: .top) {
            Rectangle().fill(Color("Rule")).frame(height: 1)
        }
    }

    // MARK: Toolbar

    @ToolbarContentBuilder
    private var toolbarContent: some ToolbarContent {
#if os(macOS)
        ToolbarItem(placement: .primaryAction) {
            Button(action: onNew) { Image(systemName: "square.and.pencil") }
                .keyboardShortcut("n", modifiers: .command)
        }
#else
        ToolbarItem(placement: .navigationBarTrailing) {
            Button(action: onNew) { Image(systemName: "square.and.pencil") }
        }
#endif
    }

    // MARK: Context menu

    @ViewBuilder
    private func contextMenuContent(for note: Note) -> some View {
        if note.status == "deleted" {
            Button("Restore") { onRestore(note) }
            Divider()
            Button("Delete Forever", role: .destructive) { onDelete(note) }
        } else {
            Button("Archive") { onArchive(note) }
            Divider()
            Button("Delete", role: .destructive) { onDelete(note) }
        }
    }
}
