import Foundation

struct MockRulesMessage: Decodable {
    let http: [HTTPMockRule]
    let socket: [SocketMockRule]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        http = try container.decodeIfPresent([HTTPMockRule].self, forKey: .http) ?? []
        socket = try container.decodeIfPresent([SocketMockRule].self, forKey: .socket) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case http, socket
    }
}

struct HTTPMockRule: Decodable, Equatable {
    let id: String
    let enabled: Bool
    let method: String?
    let urlPattern: String
    let status: Int
    let headers: [String: String]
    let body: String
    let delayMs: Int
    let delayOnly: Bool

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        method = try container.decodeIfPresent(String.self, forKey: .method)
        urlPattern = try container.decode(String.self, forKey: .urlPattern)
        status = try container.decodeIfPresent(Int.self, forKey: .status) ?? 200
        headers = try container.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
        body = try container.decodeIfPresent(String.self, forKey: .body) ?? ""
        delayMs = max(0, try container.decodeIfPresent(Int.self, forKey: .delayMs) ?? 0)
        delayOnly = try container.decodeIfPresent(Bool.self, forKey: .delayOnly) ?? false
    }

    private enum CodingKeys: String, CodingKey {
        case id, enabled, method, urlPattern, status, headers, body, delayMs, delayOnly
    }
}

struct SocketMockRule: Decodable, Equatable {
    let id: String
    let enabled: Bool
    let transport: String
    let event: String
    let ackPayload: String
    let delayMs: Int
    let pushEvent: String?
    let pushPayload: String

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        transport = try container.decodeIfPresent(String.self, forKey: .transport) ?? "socketio"
        event = try container.decode(String.self, forKey: .event)
        ackPayload = try container.decodeIfPresent(String.self, forKey: .ackPayload) ?? "[]"
        delayMs = max(0, try container.decodeIfPresent(Int.self, forKey: .delayMs) ?? 0)
        pushEvent = try container.decodeIfPresent(String.self, forKey: .pushEvent)
        pushPayload = try container.decodeIfPresent(String.self, forKey: .pushPayload) ?? "[]"
    }

    private enum CodingKeys: String, CodingKey {
        case id, enabled, transport, event, ackPayload, delayMs, pushEvent, pushPayload
    }
}

struct BreakpointRulesMessage: Decodable {
    let rules: [BreakpointRule]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        rules = try container.decodeIfPresent([BreakpointRule].self, forKey: .rules) ?? []
    }

    private enum CodingKeys: String, CodingKey {
        case rules
    }
}

struct BreakpointRule: Decodable, Equatable {
    let id: String
    let enabled: Bool
    let method: String?
    let urlPattern: String
    let phase: String

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(String.self, forKey: .id)
        enabled = try container.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        method = try container.decodeIfPresent(String.self, forKey: .method)
        urlPattern = try container.decode(String.self, forKey: .urlPattern)
        phase = try container.decodeIfPresent(String.self, forKey: .phase) ?? "response"
    }

    private enum CodingKeys: String, CodingKey {
        case id, enabled, method, urlPattern, phase
    }
}

struct BreakpointResolveMessage: Decodable {
    let id: String
    let action: String
    let status: Int?
    let headers: [String: String]?
    let body: String?
}

struct PushEventMessage: Decodable {
    let connectionId: String?
    let event: String
    let payload: String
}
