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
