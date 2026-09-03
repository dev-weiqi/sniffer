import Combine
import Foundation
import SnifferKit

@MainActor
final class SampleViewModel: ObservableObject {
    @Published private(set) var status = "Ready"
    @Published private(set) var response = ""

    private let api: APINetworkingManager
    private var request: AnyCancellable?
    private var didLoad = false

    init() {
        let host = ProcessInfo.processInfo.environment["SNIFFER_HOST"] ?? "127.0.0.1"
        let url = URL(string: "http://\(host):9091")!
        Sniffer.start(appID: "dev.weiqi.sniffer.iossample", host: host)
        api = APINetworkingManager(baseURL: url, configuration: Sniffer.configure(.default))
    }

    func loadOnce() {
        guard !didLoad else { return }
        didLoad = true
        fetchUser()
    }

    func fetchUser() {
        run(api.request(TestAPI.user(42), decode: User.self)) { user in
            "GET /test/users/42\n\n\(user.name)\n\(user.email)\nTags: \(user.tags.joined(separator: ", "))"
        }
    }

    func postEcho() {
        run(api.request(TestAPI.echo(message: "Hello from iOS"), decode: EchoResponse.self)) { echo in
            "POST \(echo.path)\n\nMethod: \(echo.method)\nBody: \(echo.body ?? "nil")"
        }
    }

    private func run<T>(_ publisher: AnyPublisher<T, Error>, format: @escaping (T) -> String) {
        status = "Loading"
        response = ""
        request = publisher
            .receive(on: DispatchQueue.main)
            .sink { [weak self] completion in
                guard case .failure(let error) = completion else { return }
                self?.status = "Failed"
                self?.response = error.localizedDescription
            } receiveValue: { [weak self] value in
                self?.status = "Success"
                self?.response = format(value)
            }
    }
}
