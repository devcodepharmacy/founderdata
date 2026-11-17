// swift-tools-version: 6.2
// Lets Xcode add FounderDataKit straight from this repository's Git URL. The package itself lives in ios/;
// ios/Package.swift is the same package for working on the SDK on its own.
import PackageDescription

let package = Package(
    name: "FounderDataKit",
    platforms: [.iOS(.v17)],
    products: [
        .library(name: "FounderDataKit", targets: ["FounderDataKit"]),
    ],
    targets: [
        .target(
            name: "FounderDataKit",
            path: "ios/Sources/FounderDataKit",
            resources: [.copy("PrivacyInfo.xcprivacy")],
            linkerSettings: [
                .linkedFramework("AdServices"),
                .linkedFramework("StoreKit"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
