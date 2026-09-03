import Foundation

final class SnifferRuntime {
    static let shared = SnifferRuntime()

    private let lock = NSLock()
    private var connection: SnifferConnection?

    private init() {}

    func start(appID: String, host: String, port: Int, deviceName: String?) {
        lock.lock()
        defer { lock.unlock() }
        guard connection == nil else { return }

        let connection = SnifferConnection(
            appID: appID,
            host: host,
            port: port,
            deviceName: deviceName ?? Device.currentName
        )
        self.connection = connection
        connection.start()
    }

    func stop() {
        lock.lock()
        let connection = connection
        self.connection = nil
        lock.unlock()
        connection?.stop()
    }

    func report(_ message: Encodable) {
        lock.lock()
        let connection = connection
        lock.unlock()
        connection?.send(message)
    }
}

private enum Device {
    static var currentName: String {
        #if canImport(UIKit)
        return UIDevice.current.name
        #else
        return ProcessInfo.processInfo.hostName
        #endif
    }
}

#if canImport(UIKit)
import UIKit
#endif

