import Foundation

private let placeholderPattern = try? NSRegularExpression(pattern: #"\$\{([^}]+)\}"#)
private let randomStringPattern = try? NSRegularExpression(pattern: #"^randomString\(\s*(\d+)\s*~\s*(\d+)\s*\)$"#)
private let loremLetters = Array("loremipsumdolorsitametconsecteturadipiscingelit")

func expandMockPlaceholders(_ template: String) -> String {
    guard let placeholderPattern else { return template }
    let range = NSRange(template.startIndex..<template.endIndex, in: template)
    var result = template
    let matches = placeholderPattern.matches(in: template, range: range)

    for match in matches.reversed() {
        guard let tokenRange = Range(match.range(at: 1), in: template) else { continue }
        let token = String(template[tokenRange])
        let replacement: String?
        switch token {
        case "randomId":
            replacement = UUID().uuidString
        case "now":
            replacement = ISO8601DateFormatter().string(from: Date())
        default:
            replacement = randomString(token)
        }
        if let replacement, let resultRange = Range(match.range(at: 0), in: result) {
            result.replaceSubrange(resultRange, with: replacement)
        }
    }
    return result
}

private func randomString(_ token: String) -> String? {
    guard let randomStringPattern else { return nil }
    let range = NSRange(token.startIndex..<token.endIndex, in: token)
    guard let match = randomStringPattern.firstMatch(in: token, range: range),
          let minRange = Range(match.range(at: 1), in: token),
          let maxRange = Range(match.range(at: 2), in: token),
          let rawMin = Int(token[minRange]),
          let rawMax = Int(token[maxRange]),
          rawMin <= rawMax else { return nil }
    let lower = min(max(0, rawMin), CapturedBody.limit)
    let upper = min(max(0, rawMax), CapturedBody.limit)
    let length = Int.random(in: lower...upper)
    return String((0..<length).compactMap { _ in loremLetters.randomElement() })
}
