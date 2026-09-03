import Foundation

public final class SnifferWebSocket: @unchecked Sendable {
    private let task: URLSessionWebSocketTask
    private let inbox = WebSocketInbox()
    private let lock = NSLock()
    private let connectionID = UUID().uuidString
    private let url: String
    private var receivePump: Task<Void, Never>?
    private var running = false

    public init(session: URLSession = .shared, url: URL) {
        task = session.webSocketTask(with: url)
        self.url = url.absoluteString
    }

    public func resume() {
        let shouldStart = lock.withLock {
            guard !running else { return false }
            running = true
            return true
        }
        guard shouldStart else { return }

        SnifferRuntime.shared.registerPushHandler(connectionID) { [weak self] event, payload in
            self?.inject(event: event, payload: payload)
        }
        task.resume()
        reportStatus("connected")
        receivePump = Task { [weak self] in await self?.pump() }
    }

    public func cancel(
        with closeCode: URLSessionWebSocketTask.CloseCode = .normalClosure,
        reason: Data? = nil
    ) {
        let wasRunning = lock.withLock {
            defer { running = false }
            return running
        }
        receivePump?.cancel()
        task.cancel(with: closeCode, reason: reason)
        Task { await inbox.finish(URLError(.cancelled)) }
        SnifferRuntime.shared.unregisterPushHandler(connectionID)
        if wasRunning { reportStatus("disconnected") }
    }

    public func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let payload = message.payload
        let rule = RuleStore.shared.socket(transport: "ktor-ws", event: payload)
        reportEvent(direction: "out", event: "message", payload: payload, mocked: rule != nil)

        guard let rule else {
            try await task.send(message)
            return
        }

        if rule.delayMs > 0 {
            let milliseconds = min(UInt64(clamping: rule.delayMs), UInt64.max / 1_000_000)
            try await Task.sleep(nanoseconds: milliseconds * 1_000_000)
        }
        let reply = expandMockPlaceholders(rule.ackPayload)
        reportEvent(direction: "in", event: "message", payload: reply, mocked: true)
        await inbox.deliver(.string(reply))
    }

    public func receive() async throws -> URLSessionWebSocketTask.Message {
        try await inbox.next()
    }

    private func pump() async {
        do {
            while !Task.isCancelled {
                let message = try await task.receive()
                reportEvent(direction: "in", event: "message", payload: message.payload, mocked: false)
                await inbox.deliver(message)
            }
        } catch {
            await inbox.finish(error)
            let wasRunning = lock.withLock {
                defer { running = false }
                return running
            }
            SnifferRuntime.shared.unregisterPushHandler(connectionID)
            if wasRunning { reportStatus("disconnected") }
        }
    }

    private func inject(event: String, payload: String) {
        reportEvent(direction: "in", event: event, payload: payload, mocked: true)
        Task { await inbox.deliver(.string(payload)) }
    }

    private func reportStatus(_ status: String) {
        SnifferRuntime.shared.report(SocketStatusMessage(
            connectionId: connectionID,
            transport: "ktor-ws",
            url: url,
            status: status,
            timestamp: nowMillis()
        ))
    }

    private func reportEvent(direction: String, event: String, payload: String, mocked: Bool) {
        SnifferRuntime.shared.report(SocketEventMessage(
            id: UUID().uuidString,
            connectionId: connectionID,
            transport: "ktor-ws",
            direction: direction,
            event: event,
            payload: payload,
            mocked: mocked,
            timestamp: nowMillis(),
            label: nil
        ))
    }
}

private actor WebSocketInbox {
    typealias Message = URLSessionWebSocketTask.Message

    private var buffered: [Message] = []
    private var waiting: [CheckedContinuation<Message, Error>] = []
    private var failure: Error?

    func deliver(_ message: Message) {
        if waiting.isEmpty {
            buffered.append(message)
        } else {
            waiting.removeFirst().resume(returning: message)
        }
    }

    func next() async throws -> Message {
        if !buffered.isEmpty { return buffered.removeFirst() }
        if let failure { throw failure }
        return try await withCheckedThrowingContinuation { waiting.append($0) }
    }

    func finish(_ error: Error) {
        failure = error
        let continuations = waiting
        waiting.removeAll()
        continuations.forEach { $0.resume(throwing: error) }
    }
}

private extension URLSessionWebSocketTask.Message {
    var payload: String {
        switch self {
        case .string(let text):
            return text
        case .data(let data):
            return data.base64EncodedString()
        @unknown default:
            return ""
        }
    }
}
