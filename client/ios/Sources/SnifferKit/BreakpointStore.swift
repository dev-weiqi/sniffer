import Foundation

enum BreakpointResolution {
    case resume(status: Int?, headers: [String: String]?, body: String?)
    case abort
}

final class BreakpointStore {
    static let shared = BreakpointStore()

    private let lock = NSLock()
    private var connected = false
    private var pending: [String: (BreakpointResolution) -> Void] = [:]

    private init() {}

    func setConnected(_ connected: Bool) {
        let released: [(BreakpointResolution) -> Void] = lock.withLock {
            self.connected = connected
            guard !connected else { return [] }
            let callbacks = Array(pending.values)
            pending.removeAll()
            return callbacks
        }
        released.forEach { $0(.resume(status: nil, headers: nil, body: nil)) }
    }

    func pause(_ hit: BreakpointHitMessage, completion: @escaping (BreakpointResolution) -> Void) {
        let registered = lock.withLock {
            guard connected else { return false }
            pending[hit.id] = completion
            return true
        }
        guard registered else {
            completion(.resume(status: nil, headers: nil, body: nil))
            return
        }
        SnifferRuntime.shared.report(hit)
    }

    func resolve(_ message: BreakpointResolveMessage) {
        let completion = lock.withLock { pending.removeValue(forKey: message.id) }
        completion?(message.action == "abort"
            ? .abort
            : .resume(status: message.status, headers: message.headers, body: message.body))
    }

    func resumeAll() {
        let callbacks = lock.withLock {
            let callbacks = Array(pending.values)
            pending.removeAll()
            return callbacks
        }
        callbacks.forEach { $0(.resume(status: nil, headers: nil, body: nil)) }
    }
}
