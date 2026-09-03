import Foundation
@_exported import SocketIO
@_spi(Plugin) import SnifferKit

public enum SnifferSocketIO {
    public static func socket(
        url: URL,
        config: SocketIOClientConfiguration = [],
        namespace: String = "/"
    ) -> SnifferSocket {
        let manager = SocketManager(socketURL: url, config: config)
        return SnifferSocket(
            delegate: manager.socket(forNamespace: namespace),
            url: url.absoluteString,
            manager: manager
        )
    }

    public static func wrap(_ socket: SocketIOClient, url: String = "") -> SnifferSocket {
        SnifferSocket(delegate: socket, url: url, manager: nil)
    }
}

public final class SnifferSocket {
    public let delegate: SocketIOClient

    private let manager: SocketManager?
    private let connectionID = UUID().uuidString
    private let url: String
    private let lock = NSLock()
    private var injecting = false
    private var anyHandler: ((SocketAnyEvent) -> Void)?
    private var labelers: [String: ([Any]) -> String?] = [:]

    fileprivate init(delegate: SocketIOClient, url: String, manager: SocketManager?) {
        self.delegate = delegate
        self.url = url
        self.manager = manager
        anyHandler = delegate.anyHandler
        installMonitor()
    }

    public var status: SocketIOStatus { delegate.status }

    public func connect(withPayload payload: [String: Any]? = nil) {
        registerPushHandler()
        delegate.connect(withPayload: payload)
    }

    public func connect(
        withPayload payload: [String: Any]? = nil,
        timeoutAfter: Double,
        withHandler handler: (() -> Void)?
    ) {
        registerPushHandler()
        delegate.connect(withPayload: payload, timeoutAfter: timeoutAfter, withHandler: handler)
    }

    public func disconnect() {
        delegate.disconnect()
        SnifferPlugin.unregisterPushHandler(connectionID: connectionID)
    }

    public func emit(_ event: String, _ items: SocketData..., completion: (() -> Void)? = nil) {
        emit(event, with: items, completion: completion)
    }

    public func emit(_ event: String, with items: [SocketData], completion: (() -> Void)? = nil) {
        let id = UUID().uuidString
        let values = representations(items)
        let rule = SnifferPlugin.socketRule(transport: "socketio", event: event)
        SnifferPlugin.reportSocketEvent(
            id: id,
            connectionID: connectionID,
            transport: "socketio",
            direction: "out",
            event: event,
            payload: jsonArray(values),
            mocked: rule != nil
        )

        guard let rule else {
            delegate.emit(event, with: items, completion: completion)
            return
        }
        if let pushEvent = rule.pushEvent, !pushEvent.isEmpty {
            schedule(after: rule.delayMs) { [weak self] in
                self?.inject(event: pushEvent, payload: SnifferPlugin.expand(rule.pushPayload))
                completion?()
            }
        } else {
            SnifferPlugin.reportSocketAck(
                id: id,
                payload: SnifferPlugin.expand(rule.ackPayload),
                mocked: true
            )
            completion?()
        }
    }

    public func emitWithAck(_ event: String, _ items: SocketData...) -> SnifferOnAckCallback {
        emitWithAck(event, with: items)
    }

    public func emitWithAck(_ event: String, with items: [SocketData]) -> SnifferOnAckCallback {
        let id = UUID().uuidString
        return SnifferOnAckCallback { [weak self] timeout, callback in
            guard let self else { return }
            let values = self.representations(items)
            let rule = SnifferPlugin.socketRule(transport: "socketio", event: event)
            SnifferPlugin.reportSocketEvent(
                id: id,
                connectionID: self.connectionID,
                transport: "socketio",
                direction: "out",
                event: event,
                payload: self.jsonArray(values),
                mocked: rule != nil
            )
            guard let rule else {
                self.delegate.emitWithAck(event, with: items).timingOut(after: timeout) { args in
                    SnifferPlugin.reportSocketAck(
                        id: id,
                        payload: self.jsonArray(args),
                        mocked: false
                    )
                    callback(args)
                }
                return
            }
            if let pushEvent = rule.pushEvent, !pushEvent.isEmpty {
                self.schedule(after: rule.delayMs) {
                    self.inject(event: pushEvent, payload: SnifferPlugin.expand(rule.pushPayload))
                }
                return
            }
            let payload = SnifferPlugin.expand(rule.ackPayload)
            self.schedule(after: rule.delayMs) {
                SnifferPlugin.reportSocketAck(id: id, payload: payload, mocked: true)
                callback(self.parsePayload(payload))
            }
        }
    }

    @discardableResult
    public func on(_ event: String, callback: @escaping NormalCallback) -> UUID {
        delegate.on(event, callback: callback)
    }

    @discardableResult
    public func on(
        _ event: String,
        label: @escaping ([Any]) -> String?,
        callback: @escaping NormalCallback
    ) -> UUID {
        lock.withLock { labelers[event] = label }
        return delegate.on(event, callback: callback)
    }

    @discardableResult
    public func on(clientEvent event: SocketClientEvent, callback: @escaping NormalCallback) -> UUID {
        delegate.on(clientEvent: event, callback: callback)
    }

    @discardableResult
    public func once(_ event: String, callback: @escaping NormalCallback) -> UUID {
        delegate.once(event, callback: callback)
    }

    @discardableResult
    public func once(clientEvent event: SocketClientEvent, callback: @escaping NormalCallback) -> UUID {
        delegate.once(clientEvent: event, callback: callback)
    }

    public func onAny(_ handler: @escaping (SocketAnyEvent) -> Void) {
        lock.withLock { anyHandler = handler }
    }

    public func off(_ event: String) {
        delegate.off(event)
        lock.withLock { _ = labelers.removeValue(forKey: event) }
    }

    public func off(clientEvent event: SocketClientEvent) {
        delegate.off(clientEvent: event)
    }

    public func off(id: UUID) {
        delegate.off(id: id)
    }

    public func removeAllHandlers() {
        delegate.removeAllHandlers()
    }

    private func installMonitor() {
        delegate.onAny { [weak self] event in
            guard let self else { return }
            let items = event.items ?? []
            let mocked = self.lock.withLock { self.injecting }
            let label = self.lock.withLock { self.labelers[event.event]?(items) }
            SnifferPlugin.reportSocketEvent(
                connectionID: self.connectionID,
                transport: "socketio",
                direction: "in",
                event: event.event,
                payload: self.jsonArray(items),
                mocked: mocked,
                label: label
            )
            if event.event == SocketClientEvent.connect.rawValue {
                self.registerPushHandler()
                SnifferPlugin.reportSocketStatus(
                    connectionID: self.connectionID,
                    transport: "socketio",
                    url: self.url,
                    status: "connected"
                )
            } else if event.event == SocketClientEvent.disconnect.rawValue {
                SnifferPlugin.unregisterPushHandler(connectionID: self.connectionID)
                SnifferPlugin.reportSocketStatus(
                    connectionID: self.connectionID,
                    transport: "socketio",
                    url: self.url,
                    status: "disconnected"
                )
            }
            self.lock.withLock { self.anyHandler }?(event)
        }
    }

    private func registerPushHandler() {
        SnifferPlugin.registerPushHandler(connectionID: connectionID) { [weak self] event, payload in
            guard let self else { return }
            let action = { self.inject(event: event, payload: payload) }
            self.delegate.manager?.handleQueue.async(execute: action) ?? action()
        }
    }

    private func inject(event: String, payload: String) {
        lock.withLock { injecting = true }
        delegate.handleEvent(event, data: parsePayload(payload), isInternalMessage: false)
        lock.withLock { injecting = false }
    }

    private func schedule(after milliseconds: Int, action: @escaping () -> Void) {
        let queue = delegate.manager?.handleQueue ?? .main
        queue.asyncAfter(deadline: .now() + .milliseconds(max(0, milliseconds)), execute: action)
    }

    private func representations(_ items: [SocketData]) -> [Any] {
        items.map { (try? $0.socketRepresentation()) ?? String(describing: $0) }
    }

    private func parsePayload(_ payload: String) -> [Any] {
        guard let data = payload.data(using: .utf8),
              let value = try? JSONSerialization.jsonObject(with: data) else { return [payload] }
        return value as? [Any] ?? [value]
    }

    private func jsonArray(_ values: [Any]) -> String {
        let safe = values.map(jsonSafe)
        guard JSONSerialization.isValidJSONObject(safe),
              let data = try? JSONSerialization.data(withJSONObject: safe),
              let text = String(data: data, encoding: .utf8) else { return "[]" }
        return text
    }

    private func jsonSafe(_ value: Any) -> Any {
        switch value {
        case is NSNull, is String, is Bool, is Int, is Int8, is Int16, is Int32, is Int64,
             is UInt, is UInt8, is UInt16, is UInt32, is UInt64, is Double, is Float:
            return value
        case let array as [Any]:
            return array.map(jsonSafe)
        case let dictionary as [String: Any]:
            return dictionary.mapValues(jsonSafe)
        default:
            return String(describing: value)
        }
    }
}

public final class SnifferOnAckCallback {
    private let action: (Double, @escaping AckCallback) -> Void

    fileprivate init(action: @escaping (Double, @escaping AckCallback) -> Void) {
        self.action = action
    }

    public func timingOut(after seconds: Double, callback: @escaping AckCallback) {
        action(seconds, callback)
    }
}

private extension NSLocking {
    func withLock<T>(_ body: () throws -> T) rethrows -> T {
        lock()
        defer { unlock() }
        return try body()
    }
}
