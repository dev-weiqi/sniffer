import Foundation

class SnifferURLProtocol: URLProtocol, URLSessionDataDelegate, @unchecked Sendable {
    private static let handledKey = "SnifferURLProtocolHandled"
    private static let configurationLock = NSLock()
    private static var forwardingConfigurations: [ObjectIdentifier: URLSessionConfiguration] = [:]
    private static var nextProtocolSlot = 0
    // ponytail: eight configured sessions; add slots if needed, while overflow skips interception to preserve owner behavior.
    private static let protocolSlots: [AnyClass] = [
        SnifferURLProtocol0.self, SnifferURLProtocol1.self, SnifferURLProtocol2.self, SnifferURLProtocol3.self,
        SnifferURLProtocol4.self, SnifferURLProtocol5.self, SnifferURLProtocol6.self, SnifferURLProtocol7.self,
    ]

    private let stateLock = NSLock()
    private var stopped = false
    private var dataTask: URLSessionDataTask?
    private var session: URLSession?
    private var delayedWork: DispatchWorkItem?
    private var id = ""
    private var method = "GET"
    private var startedAt = Date()
    private var delayedMs = 0
    private var receivedResponse: URLResponse?
    private var response: HTTPURLResponse?
    private var captured = Data()
    private var bodySize = 0
    private var heldForBreakpoint = false

    override class func canInit(with request: URLRequest) -> Bool {
        guard URLProtocol.property(forKey: handledKey, in: request) == nil else { return false }
        return request.url?.scheme == "http" || request.url?.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    static func protocolClass(for configuration: URLSessionConfiguration) -> AnyClass? {
        configurationLock.withLock {
            guard nextProtocolSlot < protocolSlots.count else { return nil }
            let protocolClass: AnyClass = protocolSlots[nextProtocolSlot]
            nextProtocolSlot += 1
            forwardingConfigurations[ObjectIdentifier(protocolClass)] = configuration.copy() as? URLSessionConfiguration
            return protocolClass
        }
    }

    static func isSnifferProtocolClass(_ candidate: AnyClass) -> Bool {
        var current: AnyClass? = candidate
        while let type = current {
            if ObjectIdentifier(type) == ObjectIdentifier(SnifferURLProtocol.self) { return true }
            current = class_getSuperclass(type)
        }
        return false
    }

    private func makeForwardingConfiguration() -> URLSessionConfiguration {
        SnifferURLProtocol.configurationLock.withLock {
            (SnifferURLProtocol.forwardingConfigurations[ObjectIdentifier(type(of: self))]?.copy() as? URLSessionConfiguration) ?? .ephemeral
        }
    }

    override func startLoading() {
        id = UUID().uuidString
        method = request.httpMethod ?? "GET"
        startedAt = Date()
        let requestBody = CapturedBody(
            data: request.httpBody,
            mimeType: request.value(forHTTPHeaderField: "Content-Type")
        )

        SnifferRuntime.shared.report(HTTPRequestMessage(
            id: id,
            method: method,
            url: request.url?.absoluteString ?? "",
            headers: request.allHTTPHeaderFields ?? [:],
            body: requestBody.text,
            bodySize: requestBody.size,
            bodyTruncated: requestBody.truncated,
            timestamp: nowMillis()
        ))

        let rule = RuleStore.shared.http(method: method, url: request.url)
        if let rule, !rule.delayOnly {
            schedule(after: rule.delayMs) { [weak self] in self?.serveMock(rule) }
            return
        }
        delayedMs = rule?.delayOnly == true ? rule?.delayMs ?? 0 : 0
        schedule(after: delayedMs) { [weak self] in self?.startRealRequest() }
    }

    override func stopLoading() {
        stateLock.withLock { stopped = true }
        delayedWork?.cancel()
        dataTask?.cancel()
        session?.invalidateAndCancel()
    }

    private func schedule(after milliseconds: Int, action: @escaping () -> Void) {
        let safeAction = { [weak self] in
            guard let self, !self.isStopped else { return }
            action()
        }
        guard milliseconds > 0 else {
            safeAction()
            return
        }
        let work = DispatchWorkItem(block: safeAction)
        delayedWork = work
        DispatchQueue.global().asyncAfter(
            deadline: .now() + .milliseconds(milliseconds),
            execute: work
        )
    }

    private func serveMock(_ rule: HTTPMockRule) {
        guard (100...599).contains(rule.status),
              let url = request.url,
              let response = HTTPURLResponse(
                url: url,
                statusCode: rule.status,
                httpVersion: "HTTP/1.1",
                headerFields: rule.headers
              ) else {
            startRealRequest()
            return
        }
        let data = Data(expandMockPlaceholders(rule.body).utf8)
        report(response: response, data: data, mocked: true)
        guard !isStopped else { return }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    private func startRealRequest() {
        let configuration = makeForwardingConfiguration()
        configuration.protocolClasses = (configuration.protocolClasses ?? []).filter {
            !SnifferURLProtocol.isSnifferProtocolClass($0)
        }
        let delegateQueue = OperationQueue()
        delegateQueue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
        self.session = session
        dataTask = session.dataTask(with: request)
        dataTask?.resume()
    }

    func urlSession(
        _ session: URLSession,
        dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        guard !isStopped else {
            completionHandler(.cancel)
            return
        }
        receivedResponse = response
        guard let http = response as? HTTPURLResponse else {
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            completionHandler(.allow)
            return
        }

        self.response = http
        let contentType = http.value(forHTTPHeaderField: "Content-Type")?.lowercased() ?? ""
        let contentLength = response.expectedContentLength
        let breakpointCandidate = (contentLength < 0 || contentLength <= Int64(CapturedBody.limit))
            && (contentType.hasPrefix("text/") || contentType.contains("json") || contentType.contains("xml"))
            && !contentType.contains("text/event-stream")
        heldForBreakpoint = breakpointCandidate
            && RuleStore.shared.breakpoint(method: method, url: request.url, phase: "response") != nil
        if !heldForBreakpoint {
            client?.urlProtocol(self, didReceive: http, cacheStoragePolicy: .notAllowed)
        }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !isStopped else { return }
        bodySize += data.count
        if heldForBreakpoint {
            if bodySize <= CapturedBody.limit {
                captured.append(data)
                return
            }
            heldForBreakpoint = false
            if let response {
                client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            }
            client?.urlProtocol(self, didLoad: captured)
            client?.urlProtocol(self, didLoad: data)
            return
        }
        if captured.count < CapturedBody.limit {
            captured.append(data.prefix(CapturedBody.limit - captured.count))
        }
        client?.urlProtocol(self, didLoad: data)
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        guard !isStopped else { return }
        defer { session.finishTasksAndInvalidate() }
        if let error {
            report(response: response, data: captured, bodySize: bodySize, error: error)
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        guard let response else {
            if receivedResponse != nil {
                client?.urlProtocolDidFinishLoading(self)
                return
            }
            failSafely(URLError(.badServerResponse))
            return
        }
        guard heldForBreakpoint,
              let rule = RuleStore.shared.breakpoint(method: method, url: request.url, phase: "response") else {
            report(response: response, data: captured, bodySize: bodySize)
            client?.urlProtocolDidFinishLoading(self)
            return
        }

        let body = CapturedBody(data: captured, totalSize: bodySize, mimeType: response.mimeType)
        BreakpointStore.shared.pause(BreakpointHitMessage(
            id: id,
            ruleId: rule.id,
            method: method,
            url: request.url?.absoluteString ?? "",
            status: response.statusCode,
            headers: headers(from: response),
            body: body.text,
            timestamp: nowMillis()
        )) { [weak self] resolution in
            self?.finishBreakpoint(resolution)
        }
    }

    private func finishBreakpoint(_ resolution: BreakpointResolution) {
        guard !isStopped, let response else { return }
        guard case let .resume(status, editedHeaders, body) = resolution else {
            client?.urlProtocol(self, didFailWithError: NSError(
                domain: "dev.weiqi.sniffer.breakpoint",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Sniffer breakpoint aborted"]
            ))
            return
        }
        let finalData = body.map { Data($0.utf8) } ?? captured
        let responseURL = response.url ?? request.url
        let finalResponse = responseURL.flatMap { HTTPURLResponse(
            url: $0,
            statusCode: status ?? response.statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: editedHeaders ?? headers(from: response)
        ) } ?? response
        report(response: finalResponse, data: finalData)
        client?.urlProtocol(self, didReceive: finalResponse, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: finalData)
        client?.urlProtocolDidFinishLoading(self)
    }

    private func report(
        response: HTTPURLResponse?,
        data: Data,
        bodySize: Int? = nil,
        mocked: Bool = false,
        error: Error? = nil
    ) {
        let body = CapturedBody(
            data: data,
            totalSize: bodySize ?? data.count,
            mimeType: response?.mimeType
        )
        SnifferRuntime.shared.report(HTTPResponseMessage(
            id: id,
            status: response?.statusCode ?? 0,
            headers: response.map(headers(from:)) ?? [:],
            body: body.text,
            bodySize: body.size,
            bodyTruncated: body.truncated,
            durationMs: Int64(Date().timeIntervalSince(startedAt) * 1_000),
            mocked: mocked,
            error: error?.localizedDescription,
            timestamp: nowMillis(),
            bodyBase64: body.base64,
            delayedMs: delayedMs
        ))
    }

    private func failSafely(_ error: Error) {
        guard !isStopped else { return }
        report(response: response, data: captured, bodySize: bodySize, error: error)
        client?.urlProtocol(self, didFailWithError: error)
    }

    private var isStopped: Bool {
        stateLock.withLock { stopped }
    }
}

private final class SnifferURLProtocol0: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol1: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol2: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol3: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol4: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol5: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol6: SnifferURLProtocol, @unchecked Sendable {}
private final class SnifferURLProtocol7: SnifferURLProtocol, @unchecked Sendable {}
