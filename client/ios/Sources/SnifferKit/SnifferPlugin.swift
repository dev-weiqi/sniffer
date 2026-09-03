import Foundation

@_spi(Plugin)
public struct SnifferPluginSocketRule: Sendable {
    public let ackPayload: String
    public let delayMs: Int
    public let pushEvent: String?
    public let pushPayload: String
}

@_spi(Plugin)
public enum SnifferPlugin {
    public static func socketRule(transport: String, event: String) -> SnifferPluginSocketRule? {
        RuleStore.shared.socket(transport: transport, event: event).map {
            SnifferPluginSocketRule(
                ackPayload: $0.ackPayload,
                delayMs: $0.delayMs,
                pushEvent: $0.pushEvent,
                pushPayload: $0.pushPayload
            )
        }
    }

    public static func expand(_ payload: String) -> String {
        expandMockPlaceholders(payload)
    }

    public static func registerPushHandler(
        connectionID: String,
        handler: @escaping (String, String) -> Void
    ) {
        SnifferRuntime.shared.registerPushHandler(connectionID, handler: handler)
    }

    public static func unregisterPushHandler(connectionID: String) {
        SnifferRuntime.shared.unregisterPushHandler(connectionID)
    }

    public static func reportSocketStatus(
        connectionID: String,
        transport: String,
        url: String,
        status: String
    ) {
        SnifferRuntime.shared.report(SocketStatusMessage(
            connectionId: connectionID,
            transport: transport,
            url: url,
            status: status,
            timestamp: nowMillis()
        ))
    }

    public static func reportSocketEvent(
        id: String = UUID().uuidString,
        connectionID: String,
        transport: String,
        direction: String,
        event: String,
        payload: String,
        mocked: Bool,
        label: String? = nil
    ) {
        SnifferRuntime.shared.report(SocketEventMessage(
            id: id,
            connectionId: connectionID,
            transport: transport,
            direction: direction,
            event: event,
            payload: payload,
            mocked: mocked,
            timestamp: nowMillis(),
            label: label
        ))
    }

    public static func reportSocketAck(id: String, payload: String?, mocked: Bool) {
        SnifferRuntime.shared.report(SocketAckMessage(
            id: id,
            payload: payload,
            mocked: mocked,
            timestamp: nowMillis()
        ))
    }
}
