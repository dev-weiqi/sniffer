import Foundation
import XCTest
import SnifferSocketIO
import SocketIO
@testable import SnifferKit

final class SocketPayloadTests: XCTestCase {
    override func tearDown() {
        RuleStore.shared.clear()
        super.tearDown()
    }

    private func install(_ rules: [[String: Any]]) throws {
        let data = try JSONSerialization.data(withJSONObject: ["socket": rules])
        RuleStore.shared.update(mocks: try JSONDecoder().decode(MockRulesMessage.self, from: data))
    }

    func testPayloadMatchingParityAndFallback() throws {
        for transport in ["socketio", "ktor-ws"] {
            let conditions: [(String, String?)] = [
                ("fallback", nil), ("invalid", "{"), ("array", "[]"),
                ("one", #"{"page":1}"#), ("two", #"{"page":2,"filter":{"active":true}}"#),
                ("duplicate", #"{"page":1}"#), ("null", #"{"cursor":null}"#),
                ("list", #"{"ids":[1,{"id":2}]}"#), ("off", #"{"page":3}"#),
            ]
            let rules: [[String: Any]] = conditions.map { id, condition in
                var rule: [String: Any] = ["id": id, "event": "", "transport": transport, "enabled": id != "off"]
                if let condition { rule["payloadMatch"] = condition }
                return rule
            }
            try install(rules)
            func match(_ text: String) -> String? {
                RuleStore.shared.socket(transport: transport, event: transport == "socketio" ? "" : text,
                                        payload: transport == "socketio" ? "[\(text)]" : text)?.id
            }
            let cases = [
                (#"{"page":1,"extra":true}"#, "one"), (#"{"page":1.0}"#, "one"),
                (#"{"page":2,"filter":{"active":true,"extra":9}}"#, "two"),
                (#"{"page":2}"#, "fallback"), (#"{"page":"1"}"#, "fallback"),
                (#"{"page":true}"#, "fallback"), (#"{"page":3}"#, "fallback"),
                (#"{"cursor":null}"#, "null"), (#"{"ids":[1,{"id":2}]}"#, "list"),
                (#"{"ids":[1,{"id":2,"extra":true}]}"#, "fallback"),
                ("{}", "fallback"), ("[]", "fallback"), ("null", "fallback"), ("{", "fallback"),
            ]
            for (text, expected) in cases { XCTAssertEqual(match(text), expected, "\(transport): \(text)") }
            try install(Array(rules.dropFirst()))
            XCTAssertNil(match(#"{"page":99}"#))
            if transport == "socketio" {
                XCTAssertNil(RuleStore.shared.socket(transport: transport, event: "other", payload: #"[{"page":1}]"#))
                XCTAssertNil(RuleStore.shared.socket(transport: transport, event: "", payload: #"[{}, {"page":1}]"#))
            }
            try install([["id": "fallback", "transport": transport, "event": "", "payloadMatch": "{}"]])
            XCTAssertEqual(match("not json"), "fallback")
        }
    }

    func testSocketIOAckAndEventRepliesUsePayloadConditions() async throws {
        try install([
            ["id": "fallback", "event": "items", "ackPayload": "[0]"],
            ["id": "one", "event": "items", "payloadMatch": #"{"page":1}"#, "ackPayload": "[1]"],
            ["id": "two", "event": "items", "payloadMatch": #"{"page":2}"#, "pushEvent": "items:result", "pushPayload": "[2]"],
        ])
        let manager = SocketManager(socketURL: URL(string: "http://127.0.0.1:1")!)
        let delegate = manager.defaultSocket
        delegate.didConnect(toNamespace: "/", payload: nil)
        let socket = SnifferSocketIO.wrap(delegate)
        let ack = expectation(description: "page one ack")
        socket.emitWithAck("items", ["page": 1]).timingOut(after: 1) { values in
            XCTAssertEqual(values.first as? Int, 1)
            ack.fulfill()
        }
        let event = expectation(description: "page two event")
        event.expectedFulfillmentCount = 2
        socket.on("items:result") { values, _ in
            XCTAssertEqual(values.first as? Int, 2)
            event.fulfill()
        }
        socket.emit("items", ["page": 2])
        socket.emitWithAck("items", ["page": 2]).timingOut(after: 1) { _ in XCTFail("event reply must not call ack") }
        let fallback = expectation(description: "unmatched page fallback")
        socket.emitWithAck("items", ["page": 3]).timingOut(after: 1) { values in
            XCTAssertEqual(values.first as? Int, 0)
            fallback.fulfill()
        }
        await fulfillment(of: [ack, event, fallback], timeout: 3)
        socket.disconnect()
    }

    func testWebSocketRepliesUsePayloadConditions() async throws {
        try install([
            ["id": "fallback", "transport": "ktor-ws", "event": "items", "ackPayload": "end"],
            ["id": "one", "transport": "ktor-ws", "event": "items", "payloadMatch": #"{"page":1}"#, "ackPayload": "one"],
            ["id": "two", "transport": "ktor-ws", "event": "items", "payloadMatch": #"{"page":2}"#, "ackPayload": "two"],
        ])
        let socket = SnifferWebSocket(url: URL(string: "ws://127.0.0.1:1")!)
        defer { socket.cancel() }
        for (page, expected) in [(1, "one"), (2, "two"), (3, "end"), (1, "one")] {
            try await socket.send(.string("{\"type\":\"items\",\"page\":\(page)}"))
            guard case .string(let reply) = try await socket.receive() else { return XCTFail("Expected a text frame") }
            XCTAssertEqual(reply, expected)
        }
    }
}
