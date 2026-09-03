import Foundation

final class SnifferRuntime {
    static let shared = SnifferRuntime()

    private let lock = NSLock()
    private var connection: SnifferConnection?
    private var pushHandlers: [String: (String, String) -> Void] = [:]
    private var liveConnections: [String: SocketStatusMessage] = [:]

    private init() {}

    func start(appID: String, host: String, port: Int, deviceName: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard connection == nil else { return }

        let connection = SnifferConnection(
            appID: appID,
            host: host,
            port: port,
            deviceName: deviceName ?? Device.currentName,
            onMessage: { [weak self] in self?.handle($0) },
            onConnection: { [weak self] connected in self?.connectionChanged(connected) }
        )
        self.connection = connection
        connection.start()
    }

    func stop() {
        lock.lock()
        let connection = connection
        self.connection = nil
        lock.unlock()
        RuleStore.shared.clear()
        BreakpointStore.shared.setConnected(false)
        connection?.stop()
    }

    func report(_ message: any SnifferDeviceMessage) {
        let connection = lock.withLock { () -> SnifferConnection? in
            if let status = message as? SocketStatusMessage {
                if status.status == "connected" {
                    liveConnections[status.connectionId] = status
                } else {
                    liveConnections.removeValue(forKey: status.connectionId)
                }
            }
            return self.connection
        }
        connection?.send(message)
    }

    func registerPushHandler(_ connectionID: String, handler: @escaping (String, String) -> Void) {
        lock.withLock { pushHandlers[connectionID] = handler }
    }

    func unregisterPushHandler(_ connectionID: String) {
        lock.withLock { _ = pushHandlers.removeValue(forKey: connectionID) }
    }

    private func connectionChanged(_ connected: Bool) {
        BreakpointStore.shared.setConnected(connected)
        guard connected else {
            RuleStore.shared.clear()
            return
        }
        let state = lock.withLock { (connection, Array(liveConnections.values)) }
        state.1.forEach { state.0?.send($0) }
    }

    func handle(_ text: String) {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String else {
            failOpen()
            return
        }
        let decoder = JSONDecoder()

        switch type {
        case "mock-rules":
            if let message = try? decoder.decode(MockRulesMessage.self, from: data) {
                RuleStore.shared.update(mocks: message)
            } else {
                RuleStore.shared.clearMocks()
            }
        case "breakpoint-rules":
            if let message = try? decoder.decode(BreakpointRulesMessage.self, from: data) {
                RuleStore.shared.update(breakpoints: message)
            } else {
                RuleStore.shared.clearBreakpoints()
                BreakpointStore.shared.resumeAll()
            }
        case "breakpoint-resolve":
            if let message = try? decoder.decode(BreakpointResolveMessage.self, from: data) {
                BreakpointStore.shared.resolve(message)
            } else {
                BreakpointStore.shared.resumeAll()
            }
        case "push-event":
            guard let message = try? decoder.decode(PushEventMessage.self, from: data) else { return }
            let handlers = lock.withLock {
                message.connectionId.flatMap { pushHandlers[$0] }.map { [$0] }
                    ?? Array(pushHandlers.values)
            }
            let payload = expandMockPlaceholders(message.payload)
            handlers.forEach { $0(message.event, payload) }
        default:
            break
        }
    }

    private func failOpen() {
        RuleStore.shared.clear()
        BreakpointStore.shared.resumeAll()
    }
}

private enum Device {
    static var currentName: String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }
}

#if canImport(UIKit)
import UIKit
#endif
