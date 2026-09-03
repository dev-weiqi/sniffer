import Foundation

protocol TargetAPI {
    var method: API.Method { get }
    var path: String { get }
    var task: API.Task { get }
    var customHeaders: [String: String]? { get }
}

extension TargetAPI {
    var customHeaders: [String: String]? { nil }

    func getURLRequest(baseURL: URL) throws -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.httpMethod = method.rawValue.uppercased()

        switch task {
        case .requestPlain:
            break
        case .requestJSONEncodable(let value):
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(value)
        case .requestURLParameters(let parameters):
            var components = URLComponents(url: request.url!, resolvingAgainstBaseURL: false)
            components?.queryItems = parameters
                .sorted { $0.key < $1.key }
                .map { URLQueryItem(name: $0.key, value: String(describing: $0.value)) }
            request.url = components?.url
        }

        customHeaders?.forEach { request.setValue($1, forHTTPHeaderField: $0) }
        return request
    }
}

