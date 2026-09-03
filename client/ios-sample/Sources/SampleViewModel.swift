import Combine
import Foundation
import SnifferKit
import SnifferSocketIO

@MainActor
final class SampleViewModel: ObservableObject {
    @Published private(set) var status = "Ready"
    @Published private(set) var response = ""

    private let baseURL: URL
    private let api: APINetworkingManager
    private var request: AnyCancellable?
    private var webSocket: SnifferWebSocket?
    private var webSocketTask: Task<Void, Never>?
    private var socketIO: SnifferSocket?
    private var didLoad = false

    init() {
        let host = ProcessInfo.processInfo.environment["SNIFFER_HOST"] ?? "127.0.0.1"
        let url = URL(string: "http://\(host):9091")!
        baseURL = url
        Sniffer.start(appID: "dev.weiqi.sniffer.iossample", host: host)
        api = APINetworkingManager(baseURL: url, configuration: Sniffer.configure(.default))
    }

    func loadOnce() {
        guard !didLoad else { return }
        didLoad = true
        Task {
            try? await Task.sleep(nanoseconds: 500_000_000)
            fetchUser()
            try? await Task.sleep(nanoseconds: 500_000_000)
            postEcho()
            try? await Task.sleep(nanoseconds: 500_000_000)
            testWebSocket()
            try? await Task.sleep(nanoseconds: 500_000_000)
            testSocketIO()
        }
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

    func testWebSocket() {
        webSocketTask?.cancel()
        webSocket?.cancel()
        guard var components = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return }
        components.scheme = baseURL.scheme == "https" ? "wss" : "ws"
        components.path = "/test/ws"
        guard let url = components.url else { return }
        let socket = SnifferWebSocket(url: url)
        webSocket = socket
        status = "WebSocket loading"
        webSocketTask = Task { [weak self] in
            do {
                socket.resume()
                try await socket.send(.string("hello from iOS"))
                let message = try await socket.receive()
                guard case .string(let text) = message else { return }
                self?.status = "WebSocket success"
                self?.response = text
            } catch {
                self?.status = "WebSocket failed"
                self?.response = error.localizedDescription
            }
        }
    }

    func testSocketIO() {
        socketIO?.disconnect()
        let socket = SnifferSocketIO.socket(url: baseURL)
        socketIO = socket
        status = "Socket.IO loading"
        socket.on(clientEvent: .connect) { [weak self, weak socket] _, _ in
            socket?.emitWithAck("chat:send", "hello from iOS").timingOut(after: 5) { values in
                Task { @MainActor [weak self] in
                    self?.status = "Socket.IO success"
                    self?.response = String(describing: values)
                }
            }
        }
        socket.on(clientEvent: .error) { [weak self] values, _ in
            Task { @MainActor [weak self] in
                self?.status = "Socket.IO failed"
                self?.response = String(describing: values)
            }
        }
        socket.connect()
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
