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
        return lock.withLock {
            httpRules.first {
                $0.enabled
                    && ($0.method == nil || $0.method?.caseInsensitiveCompare(method) == .orderedSame)
                    && !$0.urlPattern.isEmpty
                    && $0.urlPattern == path
            }
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
