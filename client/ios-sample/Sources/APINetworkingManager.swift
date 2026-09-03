import Combine
import Foundation

enum APINetworkingError: LocalizedError {
    case invalidResponse
    case httpStatus(Int, String)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The server returned an invalid response."
        case .httpStatus(let code, let body):
            return "HTTP \(code): \(body)"
        }
    }
}

final class APINetworkingManager {
    private let baseURL: URL
    private let urlSession: URLSession

    init(baseURL: URL, configuration: URLSessionConfiguration = .default) {
        self.baseURL = baseURL
        urlSession = URLSession(configuration: configuration)
    }

    func request<T: Decodable>(_ target: TargetAPI, decode: T.Type) -> AnyPublisher<T, Error> {
        Deferred { [baseURL, urlSession] () -> AnyPublisher<T, Error> in
            do {
                let request = try target.getURLRequest(baseURL: baseURL)
                return urlSession.dataTaskPublisher(for: request)
                    .tryMap { output in
                        guard let response = output.response as? HTTPURLResponse else {
                            throw APINetworkingError.invalidResponse
                        }
                        guard 200...299 ~= response.statusCode else {
                            throw APINetworkingError.httpStatus(
                                response.statusCode,
                                String(data: output.data, encoding: .utf8) ?? ""
                            )
                        }
                        return output.data
                    }
                    .decode(type: T.self, decoder: JSONDecoder())
                    .eraseToAnyPublisher()
            } catch {
                return Fail(error: error).eraseToAnyPublisher()
            }
        }
        .eraseToAnyPublisher()
    }
}

