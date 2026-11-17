import SwiftUI

struct ContentView: View {
    @StateObject private var model = SampleViewModel()
    @Environment(\.colorScheme) private var scheme
    private var dark: Bool { scheme == .dark }
    private var background: Color { dark ? Color(red: 0.114, green: 0.114, blue: 0.149) : Color(red: 0.98, green: 0.98, blue: 0.992) }
    private var panel: Color { dark ? Color(red: 0.141, green: 0.141, blue: 0.18) : .white }
    private var accent: Color { dark ? Color(red: 0.714, green: 0.627, blue: 0.906) : Color(red: 0.376, green: 0.259, blue: 0.612) }
    private var border: Color { dark ? Color(red: 0.22, green: 0.212, blue: 0.259) : Color(red: 0.898, green: 0.886, blue: 0.922) }

    var body: some View {
        GeometryReader { geometry in
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text("⌁").font(.system(size: 20)).foregroundStyle(accent)
                        .frame(width: 30, height: 30)
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(accent, lineWidth: 2))
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Sniffer").font(.system(size: 20, weight: .bold))
                        Text("iOS sample").font(.system(size: 11)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("Sample").font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                }.padding(.horizontal, 20).padding(.vertical, 16)
                Divider()
                HStack {
                    Text("Test server").font(.system(size: 11))
                    Spacer()
                    Text(model.serverAddress).font(.system(size: 10, design: .monospaced))
                }.foregroundStyle(.secondary).padding(.horizontal, 20).padding(.vertical, 8)
                Divider()
                ScrollView {
                    VStack(spacing: 0) {
                        group("HTTP / URLSession", actions: ["GET", "POST", "Error", "IMG", "WEBP", "API", "SSE"], run: model.http)
                        group("Socket.IO", actions: ["Connect", "Send", "ACK", "Req/Res", "Disconnect"]) { action in
                            switch action {
                            case "Connect": model.connectSocketIO()
                            case "Disconnect": model.disconnectSocketIO()
                            default: model.sendSocketIO(action)
                            }
                        }
                        group("URLSession WebSocket", actions: ["Connect", "Send", "ACK", "Disconnect"]) { action in
                            switch action {
                            case "Connect": model.connectWebSocket()
                            case "Disconnect": model.disconnectWebSocket()
                            default: model.sendWebSocket(ack: action == "ACK")
                            }
                        }
                    }.padding(.horizontal, 20)
                }
                VStack(spacing: 0) {
                    Divider()
                    HStack {
                        Text("Activity").font(.system(size: 12))
                        Spacer()
                        Button("Clear", action: model.clearLog).font(.system(size: 11))
                            .foregroundStyle(.secondary).frame(minWidth: 44, minHeight: 44)
                    }.padding(.leading, 18).padding(.trailing, 8)
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 8) {
                                if model.entries.isEmpty {
                                    Text("Run an action to see its output.").foregroundStyle(.secondary).font(.system(size: 11))
                                }
                                ForEach(model.entries) { entry in
                                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                                        Text(entry.time, format: .dateTime.hour().minute().second())
                                            .font(.system(size: 10, design: .monospaced)).foregroundStyle(.secondary)
                                        Text(entry.text).font(.system(size: 11, design: .monospaced))
                                            .foregroundStyle(entry.failed ? Color.red : Color.primary)
                                            .textSelection(.enabled)
                                    }.id(entry.id)
                                }
                            }.frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 18)
                        }.onChange(of: model.entries.last?.id) { id in
                            if let id { proxy.scrollTo(id, anchor: .bottom) }
                        }
                    }
                }.frame(height: min(178, geometry.size.height * 0.3)).background(panel)
            }.background(background)
        }.tint(accent)
    }

    private func group(_ title: String, actions: [String], run: @escaping (String) -> Void) -> some View {
        VStack(spacing: 10) {
            HStack {
                Text(title).font(.system(size: 13, weight: .semibold))
                Spacer()
                Text("\(actions.count) actions").font(.system(size: 10)).foregroundStyle(.secondary)
            }
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
                ForEach(actions, id: \.self) { action in
                    let primary = action == "GET" || action == "Connect"
                    Button { run(action) } label: {
                        Text(action).font(.system(size: 11, weight: .semibold)).lineLimit(1).minimumScaleFactor(0.8)
                            .foregroundStyle(action == "Error" ? .red : primary ? accent : .primary)
                            .frame(maxWidth: .infinity, minHeight: 40)
                            .background(primary ? accent.opacity(dark ? 0.13 : 0.08) : panel, in: RoundedRectangle(cornerRadius: 7))
                            .overlay(RoundedRectangle(cornerRadius: 7).stroke(primary ? .clear : border, lineWidth: 1))
                            .frame(minHeight: 44).contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
            }
        }.padding(.vertical, 14).overlay(alignment: .bottom) { Divider() }
    }
}
