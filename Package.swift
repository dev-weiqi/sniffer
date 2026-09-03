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
        .library(name: "SnifferSocketIO", targets: ["SnifferSocketIO"]),
    ],
    dependencies: [
        .package(
            url: "https://github.com/socketio/socket.io-client-swift",
            exact: "16.0.1"
        ),
        .package(
            url: "https://github.com/daltoniam/Starscream",
            exact: "4.0.4"
        ),
    ],
    targets: [
        .target(
            name: "SnifferKit",
            path: "client/ios/Sources/SnifferKit"
        ),
        .target(
            name: "SnifferSocketIO",
            dependencies: [
                "SnifferKit",
                .product(name: "SocketIO", package: "socket.io-client-swift"),
                .product(name: "Starscream", package: "Starscream"),
            ],
            path: "client/ios/Sources/SnifferSocketIO"
        ),
        .testTarget(
            name: "SnifferKitTests",
            dependencies: ["SnifferKit"],
            path: "client/ios/Tests/SnifferKitTests"
        ),
    ]
)
