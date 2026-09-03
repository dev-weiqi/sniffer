import Foundation

final class SnifferURLProtocol: URLProtocol {
    private static let handledKey = "SnifferURLProtocolHandled"
    private var dataTask: URLSessionDataTask?

    override class func canInit(with request: URLRequest) -> Bool {
        guard URLProtocol.property(forKey: handledKey, in: request) == nil else { return false }
        return request.url?.scheme == "http" || request.url?.scheme == "https"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let id = UUID().uuidString
        let startedAt = Date()
        let requestBody = CapturedBody(data: request.httpBody, mimeType: request.value(forHTTPHeaderField: "Content-Type"))

        SnifferRuntime.shared.report(HTTPRequestMessage(
            id: id,
            method: request.httpMethod ?? "GET",
            url: request.url?.absoluteString ?? "",
            headers: request.allHTTPHeaderFields ?? [:],
            body: requestBody.text,
            bodySize: requestBody.size,
            bodyTruncated: requestBody.truncated,
            timestamp: nowMillis()
        ))

        let forwarded = (request as NSURLRequest).mutableCopy() as! NSMutableURLRequest
        URLProtocol.setProperty(true, forKey: Self.handledKey, in: forwarded)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = (configuration.protocolClasses ?? []).filter { $0 != SnifferURLProtocol.self }

        dataTask = URLSession(configuration: configuration).dataTask(with: forwarded as URLRequest) { [weak self] data, response, error in
            guard let self else { return }
            let http = response as? HTTPURLResponse
            let responseBody = CapturedBody(data: data, mimeType: http?.mimeType)
            SnifferRuntime.shared.report(HTTPResponseMessage(
                id: id,
                status: http?.statusCode ?? 0,
                headers: http.map(headers(from:)) ?? [:],
                body: responseBody.text,
                bodySize: responseBody.size,
                bodyTruncated: responseBody.truncated,
                durationMs: Int64(Date().timeIntervalSince(startedAt) * 1_000),
                error: error?.localizedDescription,
                timestamp: nowMillis()
            ))

            if let error {
                self.client?.urlProtocol(self, didFailWithError: error)
                return
            }
            guard let response else {
                self.client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
                return
            }
            self.client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            if let data { self.client?.urlProtocol(self, didLoad: data) }
            self.client?.urlProtocolDidFinishLoading(self)
        }
        dataTask?.resume()
    }

    override func stopLoading() {
        dataTask?.cancel()
    }
}
