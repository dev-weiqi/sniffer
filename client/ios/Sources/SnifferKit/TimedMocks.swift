import Foundation

struct HTTPResponseStep: Decodable, Equatable {
    let status: Int
    let headers: [String: String]
    let body: String
    let delayMs: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(Int.self, forKey: .status) ?? 200
        headers = try c.decodeIfPresent([String: String].self, forKey: .headers) ?? [:]
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        delayMs = try c.decodeIfPresent(Int.self, forKey: .delayMs) ?? 0
    }
    private enum CodingKeys: String, CodingKey { case status, headers, body, delayMs }
}

struct HTTPSequence: Decodable, Equatable {
    let steps: [HTTPResponseStep]
    let onExhausted: String
    let resetToken: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        steps = try c.decode([HTTPResponseStep].self, forKey: .steps)
        onExhausted = try c.decodeIfPresent(String.self, forKey: .onExhausted) ?? "last"
        resetToken = try c.decodeIfPresent(String.self, forKey: .resetToken) ?? ""
    }
    var isValid: Bool {
        (1...100).contains(steps.count) && ["last", "loop", "stop"].contains(onExhausted)
            && steps.allSatisfy { (100...599).contains($0.status) && (0...300_000).contains($0.delayMs) }
    }
    private enum CodingKeys: String, CodingKey { case steps, onExhausted, resetToken }
}

struct HTTPStreamEvent: Decodable, Equatable {
    let data: String
    let event: String?
    let id: String?
    let retry: Int?
    let delayMs: Int

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        data = try c.decodeIfPresent(String.self, forKey: .data) ?? ""
        event = try c.decodeIfPresent(String.self, forKey: .event)
        id = try c.decodeIfPresent(String.self, forKey: .id)
        retry = try c.decodeIfPresent(Int.self, forKey: .retry)
        delayMs = try c.decodeIfPresent(Int.self, forKey: .delayMs) ?? 0
    }
    var isValid: Bool {
        data.utf16.count <= 524_288 && (0...300_000).contains(delayMs)
            && (retry.map { (0...300_000).contains($0) } ?? true)
            && [event, id].allSatisfy { value in
                value.map { $0.utf16.count <= 1024 && $0.rangeOfCharacter(from: CharacterSet(charactersIn: "\r\n\0")) == nil } ?? true
            }
    }
    func frame() -> Data {
        var lines: [String] = []
        if let event { lines.append("event: \(event)") }
        if let id { lines.append("id: \(id)") }
        if let retry { lines.append("retry: \(retry)") }
        let expanded = expandMockPlaceholders(data).replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n")
        lines += expanded.components(separatedBy: "\n").map { "data: \($0)" }
        return Data((lines.joined(separator: "\n") + "\n\n").utf8)
    }
    private enum CodingKeys: String, CodingKey { case data, event, id, retry, delayMs }
}

struct HTTPEventStream: Decodable, Equatable {
    let events: [HTTPStreamEvent]
    let ending: String

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = try c.decode([HTTPStreamEvent].self, forKey: .events)
        ending = try c.decodeIfPresent(String.self, forKey: .ending) ?? "close"
    }
    var isValid: Bool {
        (1...1000).contains(events.count) && ["close", "open", "disconnect"].contains(ending)
            && events.allSatisfy(\.isValid)
    }
    private enum CodingKeys: String, CodingKey { case events, ending }
}
