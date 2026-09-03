import SwiftUI

struct ContentView: View {
    @StateObject private var model = SampleViewModel()

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 20) {
                Text("Popup-style API client")
                    .font(.title2.bold())

                Text("http://127.0.0.1:9091")
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)

                HStack {
                    Button("Fetch user") { model.fetchUser() }
                        .buttonStyle(.borderedProminent)
                    Button("POST echo") { model.postEcho() }
                        .buttonStyle(.bordered)
                }

                HStack {
                    Button("WebSocket") { model.testWebSocket() }
                        .buttonStyle(.bordered)
                    Button("Socket.IO") { model.testSocketIO() }
                        .buttonStyle(.bordered)
                }

                LabeledContent("Status", value: model.status)

                ScrollView {
                    Text(model.response.isEmpty ? "No response yet" : model.response)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .textSelection(.enabled)
                }
                .padding()
                .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 12))

                Spacer()
            }
            .padding()
            .navigationTitle("Sniffer iOS Sample")
        }
        .task { model.loadOnce() }
    }
}
