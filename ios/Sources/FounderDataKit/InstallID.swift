import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

extension FounderData {
    /// Which install id the SDK uses while the user has not given consent (`setConsent(true)`).
    /// With consent the Keychain id wins in both modes.
    public enum InstallIDMode: Sendable, Equatable {
        /// A random id for each app launch, kept in memory. Every launch counts as a new install. The default.
        case perLaunch
        /// A SHA-256 hash of `UIDevice.identifierForVendor` and the site id, sent as a UUID. The same install
        /// comes back under the same id on every launch, without consent and without writing to the device, so
        /// retention covers it. iOS changes `identifierForVendor` when the user removes every app of your team
        /// from the device. Declare it as Device ID in the App Store privacy label (see the README).
        case vendor
    }
}

/// The `.vendor` install id: never the raw `identifierForVendor`, and a different id for each FounderData site.
enum VendorInstallID {
    /// Sent as `ctx.id` with every batch under this id, so the server counts the install for retention.
    static let contextValue = "vendor"

    /// The first 16 bytes of SHA-256("founderdata-vendor-v1:" + site id + ":" + vendor id), as a lowercase UUID
    /// with the RFC 9562 version 8 (custom) bits set, so it works as `appAccountToken`.
    static func derive(vendorId: UUID, siteId: String) -> String {
        let input = "founderdata-vendor-v1:\(siteId):\(vendorId.uuidString.lowercased())"
        var b = Array(SHA256.hash(data: Data(input.utf8)).prefix(16))
        b[6] = (b[6] & 0x0f) | 0x80
        b[8] = (b[8] & 0x3f) | 0x80
        let uuid = UUID(uuid: (b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13], b[14], b[15]))
        return uuid.uuidString.lowercased()
    }

    /// The derived id for this device, or nil when iOS has no `identifierForVendor` yet (after a restart,
    /// before the first unlock). Reads UIKit on the main thread; call it without holding a lock.
    static func current(siteId: String) -> String? {
        deviceVendorId().map { derive(vendorId: $0, siteId: siteId) }
    }

    static func deviceVendorId() -> UUID? {
        #if canImport(UIKit)
        if Thread.isMainThread {
            return MainActor.assumeIsolated { UIDevice.current.identifierForVendor }
        }
        return DispatchQueue.main.sync { MainActor.assumeIsolated { UIDevice.current.identifierForVendor } }
        #else
        return nil
        #endif
    }
}
