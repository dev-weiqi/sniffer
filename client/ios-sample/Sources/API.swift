import Foundation

typealias Parameters = [String: Any]

enum API {
    enum Method: String {
        case get, post, put, delete, patch
    }

    enum Task {
        case requestPlain
        case requestJSONEncodable(Encodable)
        case requestURLParameters(Parameters)
    }
}

