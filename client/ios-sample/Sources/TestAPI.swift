import Foundation

enum TestAPI: TargetAPI {
    case user(Int)
    case echo(message: String)

    var method: API.Method {
        switch self {
        case .user: .get
        case .echo: .post
        }
    }

    var path: String {
        switch self {
        case .user(let id): "test/users/\(id)"
        case .echo: "test/echo"
        }
    }

    var task: API.Task {
        switch self {
        case .user:
            .requestPlain
        case .echo(let message):
            .requestJSONEncodable(EchoBody(message: message))
        }
    }
}

private struct EchoBody: Encodable {
    let message: String
}

struct User: Decodable {
    let id: Int
    let name: String
    let email: String
    let tags: [String]
}

struct EchoResponse: Decodable {
    let method: String
    let path: String
    let body: String?
}

