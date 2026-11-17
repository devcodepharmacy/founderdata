import Foundation
import Testing
@testable import FounderDataKit

/// The package ships `PrivacyInfo.xcprivacy`, so Xcode's privacy report lists what the SDK collects.
@Suite("Privacy manifest")
struct PrivacyManifestTests {
    private func manifest() throws -> [String: Any] {
        let url = try #require(PrivacyManifest.url, "PrivacyInfo.xcprivacy is not in the resource bundle")
        let data = try Data(contentsOf: url)
        return try #require(try PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
    }

    @Test func declaresNoTrackingAndTheCollectedData() throws {
        let plist = try manifest()
        #expect(plist["NSPrivacyTracking"] as? Bool == false)
        #expect((plist["NSPrivacyTrackingDomains"] as? [String])?.isEmpty == true)
        let types = try #require(plist["NSPrivacyCollectedDataTypes"] as? [[String: Any]])
        #expect(Set(types.compactMap { $0["NSPrivacyCollectedDataType"] as? String }) == [
            "NSPrivacyCollectedDataTypeProductInteraction",
            "NSPrivacyCollectedDataTypePurchaseHistory",
            "NSPrivacyCollectedDataTypeCoarseLocation",
        ])
        for type in types {
            #expect(type["NSPrivacyCollectedDataTypeLinked"] as? Bool == false)
            #expect(type["NSPrivacyCollectedDataTypeTracking"] as? Bool == false)
            #expect(type["NSPrivacyCollectedDataTypePurposes"] as? [String] == ["NSPrivacyCollectedDataTypePurposeAnalytics"])
        }
    }

    @Test func declaresUserDefaultsForTheAppOnly() throws {
        let apis = try #require(try manifest()["NSPrivacyAccessedAPITypes"] as? [[String: Any]])
        #expect(apis.count == 1)
        #expect(apis.first?["NSPrivacyAccessedAPIType"] as? String == "NSPrivacyAccessedAPICategoryUserDefaults")
        #expect(apis.first?["NSPrivacyAccessedAPITypeReasons"] as? [String] == ["CA92.1"])
    }

    /// A new required-reason API in the sources fails here until the manifest declares it.
    @Test func sourcesUseNoOtherRequiredReasonAPI() throws {
        let sources = repoRoot.appendingPathComponent("ios/Sources/FounderDataKit")
        let files = try FileManager.default.contentsOfDirectory(at: sources, includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        #expect(!files.isEmpty)
        let undeclared = [
            "creationDate", "modificationDate", "contentModificationDate", "fileModificationDate", "getattrlist",
            "systemUptime", "mach_absolute_time", "volumeAvailableCapacity", "systemFreeSize", "statfs",
            "activeInputModes",
        ]
        for file in files {
            let text = try String(contentsOf: file, encoding: .utf8)
            for symbol in undeclared {
                #expect(!text.contains(symbol), "\(file.lastPathComponent) uses \(symbol)")
            }
        }
    }
}
