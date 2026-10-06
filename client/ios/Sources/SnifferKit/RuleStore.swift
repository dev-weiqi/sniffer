import Foundation

final class RuleStore {
    static let shared = RuleStore()

    private let lock = NSLock()
    private var httpRules: [HTTPMockRule] = []
    private var socketRules: [SocketMockRule] = []
    private var breakpointRules: [BreakpointRule] = []

    private init() {}

    func update(mocks: MockRulesMessage) {
        lock.withLock {
            httpRules = mocks.http
            socketRules = mocks.socket
        }
    }

    func update(breakpoints: BreakpointRulesMessage) {
        lock.withLock { breakpointRules = breakpoints.rules }
    }

    func clear() {
        lock.withLock {
            httpRules.removeAll()
            socketRules.removeAll()
            breakpointRules.removeAll()
        }
    }

    func clearMocks() {
        lock.withLock {
            httpRules.removeAll()
            socketRules.removeAll()
        }
    }

    func clearBreakpoints() {
        lock.withLock { breakpointRules.removeAll() }
    }

    func http(method: String, url: URL?) -> HTTPMockRule? {
        let path = url?.path ?? ""
        var components = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        if let query = components?.percentEncodedQuery {
            components?.percentEncodedQuery = query.replacingOccurrences(of: "+", with: "%20")
        }
        let query = components?.queryItems ?? []
        return lock.withLock {
            var fallback: HTTPMockRule?
            for rule in httpRules {
                guard rule.enabled, !rule.urlPattern.isEmpty, rule.urlPattern == path,
                      rule.method == nil || rule.method?.caseInsensitiveCompare(method) == .orderedSame else { continue }
                if rule.queryParams.isEmpty {
                    if fallback == nil { fallback = rule }
                } else if rule.queryParams.allSatisfy({ key, value in
                    !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && query.contains { $0.name == key && ($0.value ?? "") == value }
                }) {
                    return rule
                }
            }
            return fallback
        }
    }

    func socket(transport: String, event: String) -> SocketMockRule? {
        lock.withLock {
            socketRules.first {
                $0.enabled
                    && $0.transport == transport
                    && (transport == "ktor-ws" ? event.contains($0.event) : event == $0.event)
            }
        }
    }

    func breakpoint(method: String, url: URL?, phase: String) -> BreakpointRule? {
        let path = url?.path ?? ""
        return lock.withLock {
            breakpointRules.first {
                $0.enabled
                    && $0.phase == phase
                    && ($0.method == nil || $0.method?.caseInsensitiveCompare(method) == .orderedSame)
                    && normalizedPath($0.urlPattern) == path
            }
        }
    }

    private func normalizedPath(_ value: String) -> String {
        if let path = URL(string: value)?.path, !path.isEmpty { return path }
        return value.split(separator: "?", maxSplits: 1).first.map(String.init) ?? value
    }
}
