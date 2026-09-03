import Foundation
import XCTest
@testable import SnifferKit

final class SnifferKitTests: XCTestCase {
    func testConfigurationInstallsProtocolOnce() {
        let configuration = Sniffer.configure(Sniffer.configure(.ephemeral))
        let matches = configuration.protocolClasses?.filter { $0 == SnifferURLProtocol.self }
        XCTAssertEqual(matches?.count, 1)
    }

    func testCapturedBodyKeepsSizeAndCapsText() {
        let data = Data(repeating: 65, count: CapturedBody.limit + 1)
        let body = CapturedBody(data: data, mimeType: "text/plain")
        XCTAssertEqual(body.size, CapturedBody.limit + 1)
        XCTAssertEqual(body.text?.utf8.count, CapturedBody.limit)
        XCTAssertTrue(body.truncated)
    }
}

