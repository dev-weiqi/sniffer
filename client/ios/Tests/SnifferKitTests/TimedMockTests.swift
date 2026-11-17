import Foundation
import XCTest
@testable import SnifferKit

final class TimedMockTests: XCTestCase {
    private let url = URL(string: "https://mock.invalid/timed")!
    override func tearDown() { RuleStore.shared.clear(); super.tearDown() }

    private func install(_ fields: [String: Any], revision: String = "r1") throws {
        let rule = ["id": "timed", "urlPattern": "/timed"].merging(fields) { _, new in new }
        let data = try JSONSerialization.data(withJSONObject: ["revision": revision, "http": [rule]])
        RuleStore.shared.update(mocks: try JSONDecoder().decode(MockRulesMessage.self, from: data))
    }
    private func next() -> HTTPMockRule? { RuleStore.shared.http(method: "GET", url: url) }

    func testSequenceResetReconnectAndExhaustion() throws {
        let sequence: [String: Any] = ["steps": [["body": "first", "status": 503], ["body": "second"]], "onExhausted": "stop"]
        try install(["sequence": sequence])
        XCTAssertEqual(next()?.status, 503)
        RuleStore.shared.disconnect()
        try install(["sequence": sequence], revision: "r2")
        XCTAssertEqual(next()?.body, "second")
        XCTAssertEqual(next()?.sequenceExhausted, true)
        try install(["sequence": sequence.merging(["resetToken": "reset"]) { _, new in new }])
        XCTAssertEqual(next()?.stepIndex, 0)
        RuleStore.shared.clearMocks()
        try install(["sequence": sequence])
        XCTAssertEqual(next()?.stepIndex, 0)
        for mode in ["last", "loop"] {
            try install(["sequence": ["steps": [["body": "a"], ["body": "b"]], "onExhausted": mode]])
            XCTAssertEqual([next()?.body, next()?.body, next()?.body], mode == "last" ? ["a", "b", "b"] : ["a", "b", "a"])
        }
    }

    func testAtomicSequenceReservationAndInvalidRules() throws {
        try install(["sequence": ["steps": (0..<100).map { ["body": String($0)] }, "onExhausted": "stop"]])
        let lock = NSLock()
        var positions: [Int] = []
        DispatchQueue.concurrentPerform(iterations: 100) { _ in
            let index = next()!.stepIndex!
            lock.withLock { positions.append(index) }
        }
        XCTAssertEqual(positions.sorted(), Array(0..<100))
        XCTAssertNil(RuleStore.shared.http(method: "GET", url: URL(string: "https://mock.invalid/unmatched")))
        for bad: [String: Any] in [
            ["sequence": ["steps": []]],
            ["sequence": ["steps": [["status": 99]]]],
            ["sse": ["events": [["id": "bad\nid"]]]],
            ["sse": ["events": [["delayMs": -1]]]],
            ["sse": ["events": [["data": "ok"]]], "status": 500],
        ] {
            try install(bad)
            XCTAssertNil(next())
        }
    }

    func testSequenceStopDoesNotFallThroughToNetwork() async throws {
        try install(["sequence": ["steps": [["body": "only"]], "onExhausted": "stop"]])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SnifferURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let (data, _) = try await session.data(from: url)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "only")
        do {
            _ = try await session.data(from: url)
            XCTFail("Exhausted mock must fail without contacting mock.invalid")
        } catch { XCTAssertEqual((error as NSError).domain, "dev.weiqi.sniffer.sequence") }
    }

    func testSSEFramesTimingAndHeadersThroughURLSession() async throws {
        try install(["headers": ["Content-Length": "999", "Transfer-Encoding": "chunked", "Content-Type": "application/json"],
            "sse": ["events": [["data": "a\r\nb", "event": "update", "id": "1", "retry": 50, "delayMs": 70], ["data": "end", "delayMs": 70]]]])
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [SnifferURLProtocol.self]
        let session = URLSession(configuration: config)
        defer { session.invalidateAndCancel() }
        let start = Date()
        let (data, response) = try await session.data(from: url)
        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(start), 0.12)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), "event: update\nid: 1\nretry: 50\ndata: a\ndata: b\n\ndata: end\n\n")
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.value(forHTTPHeaderField: "Content-Type"), "text/event-stream; charset=utf-8")
        XCTAssertNil(http.value(forHTTPHeaderField: "Content-Length"))
        XCTAssertNil(http.value(forHTTPHeaderField: "Transfer-Encoding"))
    }

    func testSSECancellationAndDisconnect() throws {
        for ending in ["open", "disconnect"] {
            try install(["sse": ["events": [["data": "first", "delayMs": 10]], "ending": ending]])
            let frame = expectation(description: "frame")
            let finished = expectation(description: "finish")
            finished.isInverted = ending == "open"
            let client = MockProtocolClient(onData: { _ in frame.fulfill() }, onFinish: { error in
                XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
                finished.fulfill()
            })
            let loader = SnifferURLProtocol(request: URLRequest(url: url), cachedResponse: nil, client: client)
            loader.startLoading()
            wait(for: [frame], timeout: 1)
            if ending == "open" { loader.stopLoading() }
            wait(for: [finished], timeout: 0.15)
            loader.stopLoading()
        }
        try install(["sse": ["events": [["data": "late", "delayMs": 300_000]]]])
        let late = expectation(description: "cancelled stream has no callbacks")
        late.isInverted = true
        let client = MockProtocolClient(onData: { _ in late.fulfill() }, onFinish: { _ in late.fulfill() })
        let loader = SnifferURLProtocol(request: URLRequest(url: url), cachedResponse: nil, client: client)
        loader.startLoading()
        loader.stopLoading()
        wait(for: [late], timeout: 0.1)
    }

    func testObservabilityWireFormat() throws {
        let applied = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MockRulesAppliedMessage(revision: "revision"))) as! [String: Any]
        XCTAssertEqual(applied["type"] as? String, "mock-rules-applied")
        let hit = try JSONSerialization.jsonObject(with: JSONEncoder().encode(MockHitMessage(ruleId: "id", revision: "revision", timestamp: 1, stepIndex: 2))) as! [String: Any]
        XCTAssertEqual(hit["type"] as? String, "mock-hit")
        XCTAssertEqual(hit["stepIndex"] as? Int, 2)
    }
}

private final class MockProtocolClient: NSObject, URLProtocolClient {
    let onData: (Data) -> Void
    let onFinish: (Error?) -> Void
    init(onData: @escaping (Data) -> Void, onFinish: @escaping (Error?) -> Void) { self.onData = onData; self.onFinish = onFinish }
    func urlProtocol(_ p: URLProtocol, didLoad data: Data) { onData(data) }
    func urlProtocolDidFinishLoading(_ p: URLProtocol) { onFinish(nil) }
    func urlProtocol(_ p: URLProtocol, didFailWithError error: Error) { onFinish(error) }
    func urlProtocol(_ p: URLProtocol, didReceive response: URLResponse, cacheStoragePolicy policy: URLCache.StoragePolicy) {}
    func urlProtocol(_ p: URLProtocol, wasRedirectedTo request: URLRequest, redirectResponse: URLResponse) {}
    func urlProtocol(_ p: URLProtocol, cachedResponseIsValid cachedResponse: CachedURLResponse) {}
    func urlProtocol(_ p: URLProtocol, didReceive challenge: URLAuthenticationChallenge) {}
    func urlProtocol(_ p: URLProtocol, didCancel challenge: URLAuthenticationChallenge) {}
}
