import Foundation

protocol SnifferDeviceMessage: Encodable {}

struct HTTPRequestMessage: SnifferDeviceMessage {
    let type = "http-request"
    let id: String
    let method: String
    let url: String
    let headers: [String: String]
    let body: String?
    let bodySize: Int
    let bodyTruncated: Bool
    let library = "urlsession"
    let timestamp: Int64
}

struct HTTPResponseMessage: SnifferDeviceMessage {
    let type = "http-response"
    let id: String
    let status: Int
    let headers: [String: String]
    let body: String?
    let bodySize: Int
    let bodyTruncated: Bool
    let durationMs: Int64
    let mocked: Bool
    let error: String?
    let timestamp: Int64
    let bodyBase64: Bool
    let delayedMs: Int
}

struct SocketStatusMessage: SnifferDeviceMessage {
    let type = "socket-status"
    let connectionId: String
    let transport: String
    let url: String
    let status: String
    let timestamp: Int64
}

struct SocketEventMessage: SnifferDeviceMessage {
    let type = "socket-event"
    let id: String
    let connectionId: String
    let transport: String
    let direction: String
    let event: String
    let payload: String
    let mocked: Bool
    let timestamp: Int64
    let label: String?
}

struct SocketAckMessage: SnifferDeviceMessage {
    let type = "socket-ack"
    let id: String
    let payload: String?
    let mocked: Bool
    let timestamp: Int64
}

struct BreakpointHitMessage: SnifferDeviceMessage {
    let type = "breakpoint-hit"
    let id: String
    let ruleId: String
    let phase = "response"
    let method: String
    let url: String
    let status: Int
    let headers: [String: String]
    let body: String?
    let library = "urlsession"
    let timestamp: Int64
}

struct CapturedBody: Equatable {
    static let limit = 1_048_576

    let text: String?
    let size: Int
    let truncated: Bool
    let base64: Bool

    init(data: Data?, mimeType: String? = nil) {
        self.init(data: data, totalSize: data?.count ?? 0, mimeType: mimeType)
    }

    init(data: Data?, totalSize: Int, mimeType: String? = nil) {
        guard let data else {
            self = .empty
            return
        }

        size = totalSize
        truncated = totalSize > Self.limit
        let type = mimeType?.lowercased()
        let isText = type == nil
            || type?.hasPrefix("text/") == true
            || type?.contains("json") == true
            || type?.contains("xml") == true
            || type?.contains("urlencoded") == true
        let isImage = type?.hasPrefix("image/") == true
        text = isText
            ? String(data: data.prefix(Self.limit), encoding: .utf8)
            : isImage && !truncated ? data.base64EncodedString() : nil
        base64 = isImage && text != nil
    }

    private static let empty = CapturedBody(text: nil, size: 0, truncated: false, base64: false)

    private init(text: String?, size: Int, truncated: Bool, base64: Bool) {
        self.text = text
        self.size = size
        self.truncated = truncated
        self.base64 = base64
    }
}

func headers(from response: HTTPURLResponse) -> [String: String] {
    response.allHeaderFields.reduce(into: [:]) { result, pair in
        result[String(describing: pair.key)] = String(describing: pair.value)
    }
}

func nowMillis() -> Int64 {
    Int64(Date().timeIntervalSince1970 * 1_000)
}
