import Foundation
import CoreFoundation

final class RuleStore {
    static let shared = RuleStore()

    private let lock = NSLock()
    private var httpRules: [HTTPMockRule] = []
    private var socketRules: [SocketMockRule] = []
    private var revision: String?
    private var sequenceStates: [String: (sequence: HTTPSequence, next: Int)] = [:]
    private var breakpointRules: [BreakpointRule] = []

    private init() {}

    func update(mocks: MockRulesMessage) {
        lock.withLock {
            sequenceStates = sequenceStates.filter { id, state in mocks.http.contains { $0.id == id && $0.sequence == state.sequence } }
            revision = mocks.revision
            httpRules = mocks.http.filter {
                ($0.sequence == nil || ($0.sequence!.isValid && !$0.delayOnly && $0.sse == nil))
                    && ($0.sse == nil || ($0.sse!.isValid && !$0.delayOnly && $0.sequence == nil && $0.status == 200))
            }
            socketRules = mocks.socket
        }
    }

    func update(breakpoints: BreakpointRulesMessage) {
        lock.withLock { breakpointRules = breakpoints.rules }
    }

    func clear() {
        lock.withLock {
            revision = nil
            sequenceStates.removeAll()
            httpRules.removeAll()
            socketRules.removeAll()
            breakpointRules.removeAll()
        }
    }

    func clearMocks() {
        lock.withLock {
            revision = nil
            sequenceStates.removeAll()
            httpRules.removeAll()
            socketRules.removeAll()
        }
    }

    func disconnect() {
        lock.withLock {
            revision = nil
            httpRules.removeAll()
            socketRules.removeAll()
            breakpointRules.removeAll()
        }
    }

    private func selected(_ rule: HTTPMockRule) -> HTTPMockRule {
        var resolved = rule
        if let sequence = rule.sequence {
            let next = sequenceStates[rule.id]?.next ?? 0
            if sequence.onExhausted == "stop" && next >= sequence.steps.count {
                resolved.sequenceExhausted = true
                return resolved
            }
            let index = sequence.onExhausted == "loop" ? next % sequence.steps.count : min(next, sequence.steps.count - 1)
            sequenceStates[rule.id] = (sequence, sequence.onExhausted == "loop" ? (index + 1) % sequence.steps.count : min(next + 1, sequence.steps.count))
            let step = sequence.steps[index]
            resolved.status = step.status
            resolved.headers = step.headers
            resolved.body = step.body
            resolved.delayMs = step.delayMs
            resolved.stepIndex = index
        }
        reportHit(rule.id, stepIndex: resolved.stepIndex)
        return resolved
    }

    private func selected(_ rule: SocketMockRule) -> SocketMockRule {
        reportHit(rule.id, stepIndex: nil)
        return rule
    }

    private func reportHit(_ ruleId: String, stepIndex: Int?) {
        guard let revision else { return }
        SnifferRuntime.shared.report(MockHitMessage(ruleId: ruleId, revision: revision,
            timestamp: nowMillis(), stepIndex: stepIndex))
    }

    func clearBreakpoints() {
        lock.withLock { breakpointRules.removeAll() }
    }

    func http(method: String, url: URL?, body: String? = nil) -> HTTPMockRule? {
        let path = url?.path ?? ""
        var components = url.flatMap { URLComponents(url: $0, resolvingAgainstBaseURL: false) }
        if let query = components?.percentEncodedQuery {
            components?.percentEncodedQuery = query.replacingOccurrences(of: "+", with: "%20")
        }
        let query = components?.queryItems ?? []
        return lock.withLock {
            var fallback: HTTPMockRule?
            lazy var actual: Any? = {
                guard let body, body.utf8.count <= CapturedBody.limit else { return nil }
                return parseJSON(body)
            }()
            for rule in httpRules {
                guard rule.enabled, !rule.urlPattern.isEmpty, rule.urlPattern == path,
                      rule.method == nil || rule.method?.caseInsensitiveCompare(method) == .orderedSame else { continue }
                let condition = rule.bodyMatch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let expected: [String: Any]
                if condition.isEmpty {
                    expected = [:]
                } else {
                    guard let object = parseJSON(condition) as? [String: Any] else { continue }
                    expected = object
                }
                if rule.queryParams.isEmpty && expected.isEmpty {
                    if fallback == nil { fallback = rule }
                } else if rule.queryParams.allSatisfy({ key, value in
                    !key.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        && query.contains { $0.name == key && ($0.value ?? "") == value }
                }) && (expected.isEmpty || matchesJSON(expected, actual)) {
                    return selected(rule)
                }
            }
            return fallback.map { selected($0) }
        }
    }

    func socket(transport: String, event: String, payload: String? = nil) -> SocketMockRule? {
        lock.withLock {
            var fallback: SocketMockRule?
            lazy var actual: Any? = {
                guard let payload, let value = parseJSON(payload) else { return nil }
                return transport == "socketio" ? (value as? [Any])?.first : value
            }()
            for rule in socketRules {
                guard rule.enabled, rule.transport == transport,
                      transport == "ktor-ws" ? (rule.event.isEmpty || event.contains(rule.event)) : event == rule.event else { continue }
                let condition = rule.payloadMatch?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let expected: [String: Any]
                if condition.isEmpty {
                    expected = [:]
                } else {
                    guard let object = parseJSON(condition) as? [String: Any] else { continue }
                    expected = object
                }
                if expected.isEmpty {
                    if fallback == nil { fallback = rule }
                } else if matchesJSON(expected, actual) {
                    return selected(rule)
                }
            }
            return fallback.map { selected($0) }
        }
    }

    private func parseJSON(_ text: String) -> Any? {
        try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
    }

    private func matchesJSON(_ expected: Any, _ actual: Any?, partial: Bool = true) -> Bool {
        guard let actual else { return false }
        if let object = expected as? [String: Any] {
            guard let value = actual as? [String: Any], partial || object.count == value.count else { return false }
            return object.allSatisfy { matchesJSON($0.value, value[$0.key], partial: partial) }
        }
        if let array = expected as? [Any] {
            guard let value = actual as? [Any], array.count == value.count else { return false }
            return zip(array, value).allSatisfy { matchesJSON($0.0, $0.1, partial: false) }
        }
        if let number = expected as? NSNumber {
            guard let value = actual as? NSNumber,
                  (CFGetTypeID(number) == CFBooleanGetTypeID()) == (CFGetTypeID(value) == CFBooleanGetTypeID()) else { return false }
            return number.doubleValue == value.doubleValue
        }
        return (expected as? NSObject)?.isEqual(actual) == true
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
