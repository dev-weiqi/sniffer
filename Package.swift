// swift-tools-version: 5.9

import PackageDescription

let package = Package(
    name: "SnifferKit",
    platforms: [
        .iOS(.v15),
        .macOS(.v13),
    ],
    products: [
        .library(name: "SnifferKit", targets: ["SnifferKit"]),
    ],
    targets: [
        .target(
            name: "SnifferKit",
            path: "client/ios/Sources/SnifferKit"
        ),
        .testTarget(
            name: "SnifferKitTests",
            dependencies: ["SnifferKit"],
            path: "client/ios/Tests/SnifferKitTests"
        ),
    ]
)

