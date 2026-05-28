import SwiftUI

struct NoteRowView: View {
    let note: Note

    private static let dateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "MMM d"
        return f
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 4) {
                if note.pinned {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 9))
                        .foregroundStyle(Color("Muted"))
                }
                Text(note.title.isEmpty ? "Untitled note" : note.title)
                    .font(.dmSans(13, weight: .bold))
                    .foregroundStyle(Color("Ink"))
                    .lineLimit(1)
            }

            HStack(spacing: 4) {
                Text(Self.dateFormatter.string(from: note.updatedAt))
                if note.tabs.count > 1 {
                    Text("·")
                    Text("\(note.tabs.count) tabs")
                }
            }
            .font(.dmSans(11))
            .foregroundStyle(Color("Muted"))
        }
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
