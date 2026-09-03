import Foundation

public enum Sniffer {
    public static func start(
        appID: String,
        host: String = "127.0.0.1",
        port: Int = 9091,
        deviceName: String? = nil
    ) {
        SnifferRuntime.shared.start(
            appID: appID,
            host: ProcessInfo.processInfo.environment["SNIFFER_HOST"] ?? host,
            port: Int(ProcessInfo.processInfo.environment["SNIFFER_PORT"] ?? "") ?? port,
            deviceName: deviceName
        )
    }

    public static func configure(_ configuration: URLSessionConfiguration = .default) -> URLSessionConfiguration {
        var classes = configuration.protocolClasses ?? []
        if !classes.contains(where: SnifferURLProtocol.isSnifferProtocolClass),
           let protocolClass = SnifferURLProtocol.protocolClass(for: configuration) {
            classes.insert(protocolClass, at: 0)
        }
        configuration.protocolClasses = classes
        return configuration
    }

    public static func stop() {
        SnifferRuntime.shared.stop()
    }
}
