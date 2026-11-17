import Combine
import Foundation
import SnifferKit
import SnifferSocketIO

@MainActor
final class SampleViewModel: ObservableObject {
    @Published private(set) var status = "Ready"
    @Published private(set) var response = "" {
        didSet { if !response.isEmpty { log(response, failed: status.contains("failed") || status == "Failed") } }
    }
    struct LogEntry: Identifiable {
        let id = UUID()
        let time = Date()
        let text: String
        let failed: Bool
    }
    @Published private(set) var entries: [LogEntry] = []
    var serverAddress: String { baseURL.host.map { "\($0):\(baseURL.port ?? 9091)" } ?? "" }
    private lazy var httpSession = URLSession(configuration: Sniffer.configure(.ephemeral))
    private var httpTask: Task<Void, Never>?
    private var ackTask: Task<Void, Never>?
    private var pendingAck: String?

    func log(_ text: String, failed: Bool = false) {
        entries.append(LogEntry(text: String(text.prefix(8192)), failed: failed))
        if entries.count > 1000 { entries.removeFirst(entries.count - 1000) }
    }
    func clearLog() { entries.removeAll() }


    private let baseURL: URL
    private let api: APINetworkingManager
    private var request: AnyCancellable?
    private var webSocket: SnifferWebSocket?
    private var webSocketTask: Task<Void, Never>?
    private var socketIO: SnifferSocket?
    init() {
        let host = ProcessInfo.processInfo.environment["SNIFFER_HOST"] ?? "127.0.0.1"
        let url = URL(string: "http://\(host):9091")!
        baseURL = url
        Sniffer.start(appID: "dev.weiqi.sniffer.iossample", host: host)
        api = APINetworkingManager(baseURL: url, configuration: Sniffer.configure(.default))
    }

    func fetchUser() {
        run(api.request(TestAPI.user(42), decode: User.self)) { user in
            "GET /test/users/42\n\n\(user.name)\n\(user.email)\nTags: \(user.tags.joined(separator: ", "))"
        }
    }

    func postEcho() {
        run(api.request(TestAPI.echo(message: "Hello from iOS"), decode: EchoResponse.self)) { echo in
            "POST \(echo.path)\n\nMethod: \(echo.method)\nBody: \(echo.body ?? "nil")"
        }
    }

    func http(_ action: String) {
        if action == "GET" { fetchUser(); return }
        if action == "POST" { postEcho(); return }
        httpTask?.cancel()
        let url: URL
        switch action {
        case "Error": url = baseURL.appendingPathComponent("test/error")
        case "IMG": url = baseURL.appendingPathComponent("test/image")
        case "WEBP": url = URL(string: "https://mathiasbynens.be/demo/animated-webp-supported.webp")!
        case "API": url = URL(string: "https://httpbin.org/get")!
        default: url = baseURL.appendingPathComponent("test/sse")
        }
        log("HTTP / URLSession / \(action)")
        httpTask = Task {
            do {
                if action == "SSE" {
                    let (bytes, _) = try await httpSession.bytes(from: url)
                    for try await line in bytes.lines where !line.isEmpty {
                        try Task.checkCancellation()
                        log(line)
                    }
                    log("Stream completed")
                } else {
                    let (data, response) = try await httpSession.data(from: url)
                    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                    log("HTTP \(status) / \(data.count) bytes", failed: status >= 400)
                }
            } catch {
                if !Task.isCancelled { log(error.localizedDescription, failed: true) }
            }
        }
    }

    func connectWebSocket() {
        disconnectWebSocket()
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = "ws"
        components.path = "/test/ws"
        guard let url = components.url else { return }
        let socket = SnifferWebSocket(url: url)
        webSocket = socket
        socket.resume()
        log("WebSocket connecting")
        webSocketTask = Task {
            do {
                while !Task.isCancelled {
                    let message = try await socket.receive()
                    guard case .string(let text) = message else { continue }
                    if let token = pendingAck, text.contains(token) {
                        pendingAck = nil
                        ackTask?.cancel()
                        log("ACK: \(text)")
                    } else { log("WebSocket in: \(text)") }
                }
            } catch {
                if !Task.isCancelled { log(error.localizedDescription, failed: true) }
            }
        }
    }

    func sendWebSocket(ack: Bool = false) {
        guard let socket = webSocket else { log("Connect first", failed: true); return }
        let text = ack ? UUID().uuidString : "hello from iOS"
        if ack {
            ackTask?.cancel()
            pendingAck = text
            ackTask = Task {
                do { try await Task.sleep(nanoseconds: 3_000_000_000) } catch { return }
                guard pendingAck == text else { return }
                pendingAck = nil
                log("ACK timed out", failed: true)
            }
        }
        Task {
            do { try await socket.send(.string(text)); log("WebSocket out: \(text)") }
            catch { log(error.localizedDescription, failed: true) }
        }
    }

    func disconnectWebSocket() {
        webSocketTask?.cancel()
        ackTask?.cancel()
        pendingAck = nil
        webSocket?.cancel()
        if webSocket != nil { log("WebSocket disconnected") }
        webSocket = nil
    }

    func connectSocketIO() {
        socketIO?.disconnect()
        let socket = SnifferSocketIO.socket(url: baseURL)
        socketIO = socket
        for event in ["chat:new", "user:result"] {
            socket.on(event) { [weak self] values, _ in
                Task { @MainActor [weak self] in self?.log("\(event): \(values)") }
            }
        }
        socket.on(clientEvent: .connect) { [weak self] _, _ in
            Task { @MainActor [weak self] in self?.log("Socket.IO connected") }
        }
        socket.on(clientEvent: .error) { [weak self] values, _ in
            Task { @MainActor [weak self] in self?.log("Socket.IO: \(values)", failed: true) }
        }
        socket.connect()
    }

    func sendSocketIO(_ action: String) {
        guard let socket = socketIO else { log("Connect first", failed: true); return }
        switch action {
        case "ACK":
            socket.emitWithAck("chat:send", "hello from iOS").timingOut(after: 5) { [weak self] values in
                Task { @MainActor [weak self] in self?.log("ACK: \(values)") }
            }
        case "Req/Res": socket.emit("user:get", "7")
        default: socket.emit("chat:send", "hello from iOS")
        }
        log("Socket.IO / \(action)")
    }

    func disconnectSocketIO() {
        socketIO?.disconnect()
        socketIO = nil
        log("Socket.IO disconnected")
    }

    private func run<T>(_ publisher: AnyPublisher<T, Error>, format: @escaping (T) -> String) {
        status = "Loading"
        response = ""
        request = publisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard case .failure(let error) = completion else { return }
                self?.status = "Failed"
                self?.response = error.localizedDescription
            } receiveValue: { [weak self] value in
                self?.status = "Success"
                self?.response = format(value)
            }
    }
}
