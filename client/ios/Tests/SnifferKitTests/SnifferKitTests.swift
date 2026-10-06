import Foundation
import Network
import XCTest
@testable import SnifferKit

final class SnifferKitTests: XCTestCase {
    override func tearDown() {
        RuleStore.shared.clear()
        BreakpointStore.shared.setConnected(false)
        OwnerURLProtocol.handler = nil
        super.tearDown()
    }

    func testConfigurationInstallsProtocolOnce() {
        let configuration = Sniffer.configure(Sniffer.configure(.ephemeral))
        let matches = configuration.protocolClasses?.filter(SnifferURLProtocol.isSnifferProtocolClass)
        XCTAssertEqual(matches?.count, 1)
    }

    func testQueryMockPagesAndFallback() async throws {
        let json = #"""
        {"http":[
          {"id":"fallback","urlPattern":"/items","method":"GET","body":"end"},
          {"id":"one","urlPattern":"/items","method":"GET","queryParams":{"page":"1"},"body":"page one"},
          {"id":"two","urlPattern":"/items","method":"GET","queryParams":{"page":"2","size":"20"},"body":"page two"},
          {"id":"duplicate","urlPattern":"/items","method":"GET","queryParams":{"size":"20","page":"2"}},
          {"id":"off","urlPattern":"/items","enabled":false,"queryParams":{"page":"3"}},
          {"id":"encoded","urlPattern":"/items","queryParams":{"q":"茶 +&","flag":""}}
        ],"socket":[]}
        """#
        let rules = try JSONDecoder().decode(MockRulesMessage.self, from: Data(json.utf8))
        RuleStore.shared.update(mocks: rules)
        let cases = [
            ("?page=1", "one"), ("?extra=x&page=1#page=2", "one"),
            ("?size=20&%70age=%32", "two"), ("?page=2", "fallback"),
            ("?page=3", "fallback"), ("?page=20", "fallback"), ("?PAGE=1", "fallback"),
            ("", "fallback"), ("#fragment?page=1", "fallback"),
            ("?page=9&page=1", "one"),
            ("?q=%E8%8C%B6+%2B%26&flag=", "encoded"),
            ("?q=%E8%8C%B6%20%2B%26&flag", "encoded"),
            ("?q=%E8%8C%B6+%2B%26", "fallback"),
        ]
        for (query, expected) in cases {
            XCTAssertEqual(RuleStore.shared.http(method: "get", url: URL(string: "https://host/items\(query)"))?.id, expected, query)
        }
        XCTAssertNil(RuleStore.shared.http(method: "POST", url: URL(string: "https://host/items?page=1")))
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://host/items/child?page=1")))

        OwnerURLProtocol.handler = { _ in
            XCTFail("Query mocks must not reach the owner transport")
            return (500, Data())
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerURLProtocol.self]
        let session = URLSession(configuration: Sniffer.configure(configuration))
        defer { session.invalidateAndCancel() }
        for (query, expected) in [("?page=1", "page one"), ("?size=20&page=2", "page two"), ("?page=3", "end"), ("?page=1", "page one")] {
            let (data, _) = try await session.data(from: URL(string: "https://owner.invalid/items\(query)")!)
            XCTAssertEqual(String(decoding: data, as: UTF8.self), expected)
        }
        SnifferRuntime.shared.handle(#"{"type":"mock-rules","http":[{"id":"one","urlPattern":"/items","queryParams":{"page":"1"}}],"socket":[]}"#)
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://host/items?page=99")))
    }

    func testHTTPBodyConditionsRequireQueryAndTypedJSONFields() throws {
        let rules = try JSONDecoder().decode(MockRulesMessage.self, from: Data(#"""
        {"http":[
          {"id":"fallback","method":"POST","urlPattern":"/messages"},
          {"id":"invalid","method":"POST","urlPattern":"/messages","bodyMatch":"{"},
          {"id":"one","method":"POST","urlPattern":"/messages","queryParams":{"locale":"zh-TW"},"bodyMatch":"{\"session_id\":\"session\",\"limit\":20}"},
          {"id":"nested","method":"POST","urlPattern":"/messages","bodyMatch":"{\"filter\":{\"active\":true},\"ids\":[1,{\"id\":2}]}"},
          {"id":"null","method":"POST","urlPattern":"/messages","bodyMatch":"{\"cursor\":null}"}
        ]}
        """#.utf8))
        RuleStore.shared.update(mocks: rules)
        let url = URL(string: "https://host/messages?locale=zh-TW")!
        let cases: [(String?, String)] = [
            (#"{"session_id":"session","limit":20,"extra":true}"#, "one"),
            (#"{"session_id":"session","limit":20.0}"#, "one"),
            (#"{"session_id":"session","limit":"20"}"#, "fallback"),
            (#"{"session_id":"session","limit":true}"#, "fallback"),
            (#"{"filter":{"active":true,"extra":1},"ids":[1,{"id":2}]}"#, "nested"),
            (#"{"filter":{"active":true},"ids":[1,{"id":2,"extra":1}]}"#, "fallback"),
            (#"{"cursor":null}"#, "null"),
            ("{}", "fallback"), ("[]", "fallback"), ("{", "fallback"), (nil, "fallback"),
        ]
        for (body, expected) in cases {
            XCTAssertEqual(RuleStore.shared.http(method: "post", url: url, body: body)?.id, expected)
        }
        XCTAssertEqual(RuleStore.shared.http(method: "POST", url: URL(string: "https://host/messages?locale=en-US"), body: cases[0].0)?.id, "fallback")
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: url, body: cases[0].0))
        XCTAssertNil(RuleStore.shared.http(method: "POST", url: URL(string: "https://host/messages/child"), body: cases[0].0))
    }

    func testHTTPBodyMocksSupportDataStreamsAndPreserveUnmatchedBodies() async throws {
        let rules = try JSONDecoder().decode(MockRulesMessage.self, from: Data(#"""
        {"http":[{"id":"body","method":"POST","urlPattern":"/messages","queryParams":{"locale":"zh-TW"},"bodyMatch":"{\"session_id\":\"session\",\"limit\":20}","body":"mocked"}]}
        """#.utf8))
        RuleStore.shared.update(mocks: rules)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerURLProtocol.self]
        let session = URLSession(configuration: Sniffer.configure(configuration))
        defer { session.invalidateAndCancel() }
        OwnerURLProtocol.handler = { request in
            let stream = request.httpBodyStream ?? InputStream(data: request.httpBody ?? Data())
            stream.open()
            defer { stream.close() }
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                data.append(contentsOf: buffer.prefix(count))
            }
            return (200, data)
        }
        let json = #"{"session_id":"session","limit":20}"#
        let different = #"{"session_id":"session","limit":40}"#
        for stream in [false, true] {
            for (body, locale, expected) in [(json, "zh-TW", "mocked"), (json, "en-US", json), (different, "zh-TW", different)] {
                var request = URLRequest(url: URL(string: "https://owner.invalid/messages?locale=\(locale)")!)
                request.httpMethod = "POST"
                request.setValue("application/json", forHTTPHeaderField: "Content-Type")
                if stream { request.httpBodyStream = InputStream(data: Data(body.utf8)) }
                else { request.httpBody = Data(body.utf8) }
                let (data, _) = try await session.data(for: request)
                XCTAssertEqual(String(decoding: data, as: UTF8.self), expected)
            }
        }
    }

    func testCapturedBodyKeepsSizeAndCapsText() {
        let data = Data(repeating: 65, count: CapturedBody.limit + 1)
        let body = CapturedBody(data: data, mimeType: "text/plain")
        XCTAssertEqual(body.size, CapturedBody.limit + 1)
        XCTAssertEqual(body.text?.utf8.count, CapturedBody.limit)
        XCTAssertTrue(body.truncated)
    }

    func testRequestBodyIsReportedAndForwarded() async throws {
        let body = Data(#"{"message":"hello"}"#.utf8)
        let cases: [(path: String, body: Data?, contentType: String)] = [
            ("data", body, "application/json"),
            ("stream", body, "application/json"),
            ("upload", body, "application/json"),
            ("form", Data("message=hello&count=2".utf8), "application/x-www-form-urlencoded"),
            ("large", Data(repeating: 65, count: CapturedBody.limit + 1), "text/plain"),
            ("empty", nil, "application/json"),
        ]
        let ready = expectation(description: "daemon listening")
        let reported = expectation(description: "request body reported")
        reported.expectedFulfillmentCount = cases.count
        let parameters = NWParameters.tcp
        parameters.defaultProtocolStack.applicationProtocols.insert(NWProtocolWebSocket.Options(), at: 0)
        let listener = try NWListener(using: parameters, on: .any)
        listener.stateUpdateHandler = { if case .ready = $0 { ready.fulfill() } }
        listener.newConnectionHandler = { connection in
            var remaining = cases.count
            func receive() {
                connection.receiveMessage { data, _, _, error in
                    if let data,
                       let message = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                       message["type"] as? String == "http-request" {
                        let path = (message["url"] as? String).flatMap(URL.init(string:))?.lastPathComponent
                        let expected = cases.first { $0.path == path }
                        XCTAssertNotNil(expected)
                        let data = expected?.body
                        XCTAssertEqual(message["body"] as? String, data.map { String(decoding: $0.prefix(CapturedBody.limit), as: UTF8.self) })
                        XCTAssertEqual(message["bodySize"] as? Int, data?.count ?? 0)
                        XCTAssertEqual(message["bodyTruncated"] as? Bool, (data?.count ?? 0) > CapturedBody.limit)
                        reported.fulfill()
                        remaining -= 1
                        if remaining == 0 {
                            connection.cancel()
                            return
                        }
                    }
                    if error == nil { receive() }
                }
            }
            connection.start(queue: .global())
            receive()
        }
        listener.start(queue: .global())
        defer {
            Sniffer.stop()
            listener.cancel()
        }
        await fulfillment(of: [ready], timeout: 3)
        let port = try XCTUnwrap(listener.port)
        SnifferRuntime.shared.start(appID: "body-test", host: "127.0.0.1", port: Int(port.rawValue), deviceName: "test")

        OwnerURLProtocol.handler = { request in
            let stream = request.httpBodyStream ?? InputStream(data: request.httpBody ?? Data())
            stream.open()
            defer { stream.close() }
            var forwarded = Data()
            var buffer = [UInt8](repeating: 0, count: 1024)
            while true {
                let count = stream.read(&buffer, maxLength: buffer.count)
                guard count > 0 else { break }
                forwarded.append(contentsOf: buffer.prefix(count))
            }
            let expected = cases.first { $0.path == request.url?.lastPathComponent }
            XCTAssertNotNil(expected)
            XCTAssertEqual(forwarded, expected?.body ?? Data())
            return (200, forwarded)
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerURLProtocol.self]
        let session = URLSession(configuration: Sniffer.configure(configuration))
        defer { session.invalidateAndCancel() }
        for item in cases {
            var request = URLRequest(url: URL(string: "https://owner.invalid/\(item.path)")!)
            request.httpMethod = item.body == nil ? "GET" : "POST"
            request.setValue(item.contentType, forHTTPHeaderField: "Content-Type")
            let data: Data
            if item.path == "upload" {
                (data, _) = try await session.upload(for: request, from: body)
            } else {
                if item.path == "stream" {
                    request.httpBodyStream = InputStream(data: body)
                } else {
                    request.httpBody = item.body
                }
                (data, _) = try await session.data(for: request)
            }
            XCTAssertEqual(data, item.body ?? Data(), item.path)
        }
        await fulfillment(of: [reported], timeout: 3)
    }

    func testPlaceholderExpansionKeepsUnknownTokensAndExpandsSupportedTokens() {
        let expanded = expandMockPlaceholders("${randomString(4~4)}|${unknown}")
        let parts = expanded.split(separator: "|", omittingEmptySubsequences: false)
        XCTAssertEqual(parts.first?.count, 4)
        XCTAssertEqual(parts.last, "${unknown}")
    }

    func testInvalidMockFallsThroughToOwnersOriginalRequest() async throws {
        RuleStore.shared.update(mocks: try mockRules(status: 99))
        OwnerURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "X-Owner"), "kept")
            return (201, Data("owner-response".utf8))
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpAdditionalHeaders = ["X-Owner": "kept"]
        configuration.protocolClasses = [OwnerURLProtocol.self]
        let session = URLSession(configuration: Sniffer.configure(configuration))
        let (data, response) = try await session.data(from: URL(string: "https://owner.invalid/test")!)

        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 201)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "owner-response")
    }

    func testConfiguredSessionsKeepTheirOwnOwnerConfiguration() async throws {
        OwnerURLProtocol.handler = { request in
            (200, Data((request.value(forHTTPHeaderField: "X-Owner") ?? "missing").utf8))
        }
        let first = URLSessionConfiguration.ephemeral
        first.httpAdditionalHeaders = ["X-Owner": "first"]
        first.protocolClasses = [OwnerURLProtocol.self]
        let firstSession = URLSession(configuration: Sniffer.configure(first))

        let second = URLSessionConfiguration.ephemeral
        second.httpAdditionalHeaders = ["X-Owner": "second"]
        second.protocolClasses = [OwnerURLProtocol.self]
        let secondSession = URLSession(configuration: Sniffer.configure(second))

        let url = URL(string: "https://owner.invalid/test")!
        let (firstData, _) = try await firstSession.data(from: url)
        let (secondData, _) = try await secondSession.data(from: url)
        XCTAssertEqual(String(decoding: firstData, as: UTF8.self), "first")
        XCTAssertEqual(String(decoding: secondData, as: UTF8.self), "second")
    }

    func testMatchedMockDoesNotCallOwnerTransport() async throws {
        RuleStore.shared.update(mocks: try mockRules(status: 202, body: #"{"source":"mock"}"#))
        OwnerURLProtocol.handler = { _ in
            XCTFail("Matched mock must not reach owner transport")
            return (500, Data())
        }

        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [OwnerURLProtocol.self]
        let session = URLSession(configuration: Sniffer.configure(configuration))
        let (data, response) = try await session.data(from: URL(string: "https://owner.invalid/test")!)

        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 202)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), #"{"source":"mock"}"#)
    }

    func testDisconnectClearsRules() throws {
        RuleStore.shared.update(mocks: try mockRules(status: 202))
        XCTAssertNotNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://owner.invalid/test")))
        RuleStore.shared.clear()
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://owner.invalid/test")))
    }

    func testMalformedDaemonMessageClearsRulesAndResumesBreakpoint() throws {
        RuleStore.shared.update(mocks: try mockRules(status: 202))
        BreakpointStore.shared.setConnected(true)
        let resumed = expectation(description: "breakpoint resumed")
        BreakpointStore.shared.pause(BreakpointHitMessage(
            id: "hit-1",
            ruleId: "rule-1",
            method: "GET",
            url: "https://owner.invalid/test",
            status: 200,
            headers: [:],
            body: "owner-response",
            timestamp: 0
        )) { resolution in
            guard case .resume = resolution else { return }
            resumed.fulfill()
        }

        SnifferRuntime.shared.handle("{malformed")

        wait(for: [resumed], timeout: 0.1)
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://owner.invalid/test")))
    }

    private func mockRules(status: Int, body: String = "mock") throws -> MockRulesMessage {
        let object: [String: Any] = [
            "http": [[
                "id": "rule-1",
                "method": "GET",
                "urlPattern": "/test",
                "status": status,
                "body": body,
            ]],
            "socket": [],
        ]
        let data = try JSONSerialization.data(withJSONObject: object)
        return try JSONDecoder().decode(MockRulesMessage.self, from: data)
    }
}

private final class OwnerURLProtocol: URLProtocol, @unchecked Sendable {
    static var handler: ((URLRequest) -> (Int, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let url = request.url, let result = Self.handler?(request),
              let response = HTTPURLResponse(
                url: url,
                statusCode: result.0,
                httpVersion: "HTTP/1.1",
                headerFields: ["Content-Type": "text/plain"]
              ) else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotLoadFromNetwork))
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: result.1)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
