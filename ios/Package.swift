// swift-tools-version: 6.2
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
            resources: [.copy("PrivacyInfo.xcprivacy")],
            linkerSettings: [
                .linkedFramework("AdServices"),
                .linkedFramework("StoreKit"),
            ]
        ),
        .testTarget(
            name: "FounderDataKitTests",
            dependencies: ["FounderDataKit"],
            // Read from the source folder by StoreKitPurchaseTests, not bundled.
            exclude: ["FounderDataKitTests.storekit"]
        ),
    ],
    swiftLanguageModes: [.v6]
)
