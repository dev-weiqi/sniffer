import Foundation

final class SnifferConnection: NSObject, URLSessionWebSocketDelegate, @unchecked Sendable {
    private let appID: String
    private let host: String
    private let port: Int
    private let deviceName: String
    private let queue = DispatchQueue(label: "dev.weiqi.sniffer.connection")

    private var session: URLSession?
    private var socket: URLSessionWebSocketTask?
    private var pending: [String] = []
    private var connected = false
    private var stopped = false
    private var reconnectScheduled = false

    init(appID: String, host: String, port: Int, deviceName: String) {
        self.appID = appID
        self.host = host
        self.port = port
        self.deviceName = deviceName
    }

    func start() {
        queue.async { self.connect() }
    }

    func stop() {
        queue.async {
            self.stopped = true
            self.connected = false
            self.socket?.cancel(with: .goingAway, reason: nil)
            self.session?.invalidateAndCancel()
            self.socket = nil
            self.session = nil
            self.pending.removeAll()
        }
    }

    func send(_ message: Encodable) {
        guard let data = try? JSONEncoder().encode(AnyEncodable(message)),
              let text = String(data: data, encoding: .utf8) else { return }
        queue.async { self.sendOrBuffer(text) }
    }

    private func connect() {
        guard !stopped, socket == nil,
              let url = URL(string: "ws://\(host):\(port)/device") else { return }

        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        let socket = session.webSocketTask(with: url)
        self.session = session
        self.socket = socket
        socket.resume()
        receive(on: socket)
    }

    private func receive(on socket: URLSessionWebSocketTask) {
        socket.receive { [weak self, weak socket] result in
            guard let self, let socket else { return }
            self.queue.async {
                guard self.socket === socket, !self.stopped else { return }
                switch result {
                case .success:
                    self.receive(on: socket)
                case .failure:
                    self.disconnectAndRetry()
                }
            }
        }
    }

    private func sendOrBuffer(_ text: String) {
        guard connected, let socket else {
            pending.append(text)
            if pending.count > 1_000 { pending.removeFirst(pending.count - 1_000) }
            return
        }
        socket.send(.string(text)) { [weak self, weak socket] error in
            guard error != nil, let self, let socket else { return }
            self.queue.async {
                guard self.socket === socket else { return }
                self.pending.append(text)
                if self.pending.count > 1_000 { self.pending.removeFirst(self.pending.count - 1_000) }
                self.disconnectAndRetry()
            }
        }
    }

    private func disconnectAndRetry() {
        connected = false
        socket?.cancel()
        session?.invalidateAndCancel()
        socket = nil
        session = nil
        guard !stopped, !reconnectScheduled else { return }
        reconnectScheduled = true
        queue.asyncAfter(deadline: .now() + 3) {
            self.reconnectScheduled = false
            self.connect()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        queue.async {
            guard self.socket === webSocketTask, !self.stopped else { return }
            self.connected = true
            self.sendOrBuffer(HelloMessage(
                deviceId: DeviceIdentifier.current,
                deviceName: self.deviceName,
                appId: self.appID
            ).json)
            let buffered = self.pending
            self.pending.removeAll()
            buffered.forEach(self.sendOrBuffer)
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        queue.async {
            guard self.socket === webSocketTask else { return }
            self.disconnectAndRetry()
        }
    }
}

private struct HelloMessage: Encodable {
    let type = "hello"
    let deviceId: String
    let deviceName: String
    let platform = "ios"
    let appId: String
    let sdkVersion = "0.1.0"
    let capabilities = ["http"]

    var json: String {
        guard let data = try? JSONEncoder().encode(self) else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

private enum DeviceIdentifier {
    static var current: String {
        #if canImport(UIKit)
        return UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }
}

private struct AnyEncodable: Encodable {
    private let encodeValue: (Encoder) throws -> Void

    init(_ value: Encodable) {
        encodeValue = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeValue(encoder)
    }
}

#if canImport(UIKit)
import UIKit
#endif

