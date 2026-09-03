import Foundation

struct HTTPRequestMessage: Encodable {
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

struct HTTPResponseMessage: Encodable {
    let type = "http-response"
    let id: String
    let status: Int
    let headers: [String: String]
    let body: String?
    let bodySize: Int
    let bodyTruncated: Bool
    let durationMs: Int64
    let mocked = false
    let error: String?
    let timestamp: Int64
}

struct CapturedBody: Equatable {
    static let limit = 1_048_576

    let text: String?
    let size: Int
    let truncated: Bool

    init(data: Data?, mimeType: String? = nil) {
        guard let data else {
            self = .empty
            return
        }

        size = data.count
        truncated = data.count > Self.limit
        let type = mimeType?.lowercased()
        let isText = type == nil
            || type?.hasPrefix("text/") == true
            || type?.contains("json") == true
            || type?.contains("xml") == true
            || type?.contains("urlencoded") == true
        text = isText ? String(data: data.prefix(Self.limit), encoding: .utf8) : nil
    }

    private static let empty = CapturedBody(text: nil, size: 0, truncated: false)

    private init(text: String?, size: Int, truncated: Bool) {
        self.text = text
        self.size = size
        self.truncated = truncated
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

