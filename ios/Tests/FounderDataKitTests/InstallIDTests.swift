import Foundation
import StoreKit
import Testing
@testable import FounderDataKit

/// `configure(..., installId: .vendor)`: one id per install without consent, derived from
/// `identifierForVendor` and the site id, never the raw value. `.perLaunch` stays the default.
@Suite("Vendor install id")
struct VendorInstallIDTests {
    private let vendor = UUID(uuidString: "6F1C2B9E-0D4A-4E57-9A0B-3C2D1E0F9A8B")!
    private let launchId = "11111111-2222-4333-8444-555555555555"

    @Test func derivationIsStableAndPinned() {
        let id = VendorInstallID.derive(vendorId: vendor, siteId: "site_1")
        #expect(id == VendorInstallID.derive(vendorId: vendor, siteId: "site_1"))
        // SHA-256("founderdata-vendor-v1:site_1:6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"), first 16 bytes, version 8 bits.
        #expect(id == "fd3e0654-a0ac-81a4-a1dd-6a15db8edbe4")
        #expect(UUID(uuidString: id)?.uuidString.lowercased() == id)
        #expect(Array(id)[14] == "8", "RFC 9562 version 8")
        #expect(InstallIDStore.normalized(id) == id, "usable as appAccountToken")
    }

    @Test func saltedWithTheSiteIdAndNeverTheRawValue() {
        let one = VendorInstallID.derive(vendorId: vendor, siteId: "site_1")
        let two = VendorInstallID.derive(vendorId: vendor, siteId: "site_2")
        #expect(two == "7100c543-4328-88cc-8505-c7ed7fee51bc")
        #expect(one != two, "two FounderData sites of one team get unrelated ids")
        #expect(one != vendor.uuidString.lowercased())
        let other = VendorInstallID.derive(vendorId: UUID(), siteId: "site_1")
        #expect(other != one)
    }

    @MainActor
    @Test func theDeviceIdComesBackTheSame() throws {
        guard let raw = VendorInstallID.deviceVendorId() else {
            print("VendorInstallIDTests: no identifierForVendor in this test run")
            return
        }
        let first = try #require(VendorInstallID.current(siteId: "site_1"))
        #expect(VendorInstallID.current(siteId: "site_1") == first)
        #expect(first == VendorInstallID.derive(vendorId: raw, siteId: "site_1"))
        #expect(!first.contains(raw.uuidString.lowercased()))
    }

    @Test func consentKeepsTheKeychainIdFirst() {
        let vendorId = VendorInstallID.derive(vendorId: vendor, siteId: "site_1")
        let stored = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
        let asked = Locked<[String]>([])
        let keychainWithId: (String) -> String = { candidate in asked.withLock { $0.append(candidate) }; return stored }
        let emptyKeychain: (String) -> String = { candidate in asked.withLock { $0.append(candidate) }; return candidate }

        #expect(FounderData.startingInstallId(consent: true, launchId: launchId, vendorId: vendorId, keychain: keychainWithId) == stored)
        #expect(FounderData.startingInstallId(consent: true, launchId: launchId, vendorId: vendorId, keychain: emptyKeychain) == vendorId,
                "a first consent stores the vendor id, so the install keeps its id")
        #expect(FounderData.startingInstallId(consent: true, launchId: launchId, vendorId: nil, keychain: emptyKeychain) == launchId)
        #expect(asked.withLock { $0 } == [vendorId, vendorId, launchId])

        asked.withLock { $0 = [] }
        #expect(FounderData.startingInstallId(consent: false, launchId: launchId, vendorId: vendorId, keychain: keychainWithId) == vendorId)
        #expect(FounderData.startingInstallId(consent: false, launchId: launchId, vendorId: nil, keychain: keychainWithId) == launchId)
        #expect(asked.withLock { $0 }.isEmpty, "no Keychain access without consent")
    }

    @Test func vendorEventsCarryTheContextFlag() throws {
        let vendorId = VendorInstallID.derive(vendorId: vendor, siteId: "site_1")
        let h = Harness(persistent: false, vendorInstallId: vendorId)
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        #expect(h.core.installId == vendorId)
        #expect(h.core.snapshot.queue.items.allSatisfy { $0.ctx.id == "vendor" && $0.ctx.consent == nil })
        let body = try #require(h.core.snapshot.queue.nextBatch(siteId: "site_1")).body
        let text = String(decoding: body, as: UTF8.self)
        #expect(text.contains(#""id":"vendor""#))
        #expect(text.contains(#""vid":"\#(vendorId)""#))
        #expect(!FileManager.default.fileExists(atPath: h.directory.path), "nothing written to the device")
    }

    @Test func consentAndResetReplaceTheFlag() throws {
        let vendorId = VendorInstallID.derive(vendorId: vendor, siteId: "site_1")
        let consented = Harness(persistent: false, vendorInstallId: vendorId)
        defer { consented.cleanUp() }
        consented.core.enablePersistence(store: StateStore(fileURL: consented.stateFile), installId: vendorId)
        consented.core.record(.screen("Home"))
        let last = try #require(consented.core.snapshot.queue.items.last)
        #expect(last.ctx.consent == true)
        #expect(last.ctx.id == nil)

        let signedOut = Harness(persistent: false, vendorInstallId: vendorId)
        signedOut.core.record(.screen("Account"))
        signedOut.core.resetIdentity(installId: launchId)
        signedOut.core.record(.screen("SignIn"))
        let items = signedOut.core.snapshot.queue.items
        #expect(items.filter { $0.vid == vendorId }.allSatisfy { $0.ctx.id == "vendor" })
        #expect(items.filter { $0.vid == launchId }.allSatisfy { $0.ctx.id == nil })
        #expect(items.last?.vid == launchId)
    }

    @Test func perLaunchSendsNoFlag() throws {
        let h = Harness(persistent: false)
        h.core.record(.screen("Home"))
        #expect(h.core.snapshot.queue.items.allSatisfy { $0.ctx.id == nil })
        let body = try #require(h.core.snapshot.queue.nextBatch(siteId: "site_1")).body
        #expect(!String(decoding: body, as: UTF8.self).contains(#""id""#))
    }

    /// The public `configure` without `installId` uses per-launch ids, even where `identifierForVendor` exists.
    @Test func theDefaultIsPerLaunch() throws {
        FounderData.configure(siteId: "site_consent_test", host: "http://127.0.0.1:9")
        let core = try #require(FounderData.current)
        #expect(core.config.vendorInstallId == nil)
        if let raw = VendorInstallID.deviceVendorId() {
            #expect(core.installId != VendorInstallID.derive(vendorId: raw, siteId: "site_consent_test"))
        }
    }
}

/// `FounderData.trackPurchase(product:source:_:)`, the purchase helper for RevenueCat and other purchase code.
@Suite("Purchase helper for RevenueCat")
struct TrackPurchaseTests {
    typealias Outcome = FounderData.PurchaseOutcome

    @Test func eachReturnedOutcomeSendsItsGoal() async {
        let cases: [(Outcome, [String], [String: String])] = [
            (.purchased, ["purchase_start"], [:]),
            (.cancelled, ["purchase_start", "purchase_cancelled"], [:]),
            (.pending, ["purchase_start", "purchase_pending"], [:]),
            (.failed(.network), ["purchase_start", "purchase_failed"], ["reason": "network"]),
            (.failed(.store), ["purchase_start", "purchase_failed"], ["reason": "store"]),
        ]
        for (outcome, names, extra) in cases {
            let recorder = PurchaseRecorder()
            let returned = await FounderData.trackPurchase(product: "pro_yearly", source: .onboarding, send: recorder.send) { outcome }
            #expect(returned == outcome)
            #expect(recorder.names == names, "\(outcome)")
            #expect(recorder.goals.last?.props == ["source": "onboarding", "product": "pro_yearly"].merging(extra) { $1 })
        }
    }

    @Test func revenueCatErrorsAreSortedAndThrownAgain() async {
        let rc = { (code: Int) in NSError(domain: "RevenueCat.ErrorCode", code: code) }
        let cases: [(any Error, String, [String: String])] = [
            (rc(1), "purchase_cancelled", [:]),
            (rc(20), "purchase_pending", [:]),
            (rc(10), "purchase_failed", ["reason": "network"]),
            (rc(2), "purchase_failed", ["reason": "store"]),
            (NSError(domain: "RCPurchasesErrorCodeDomain", code: 1), "purchase_cancelled", [:]),
            (StoreKitError.userCancelled, "purchase_cancelled", [:]),
            (URLError(.notConnectedToInternet), "purchase_failed", ["reason": "network"]),
            (CocoaError(.fileNoSuchFile), "purchase_failed", ["reason": "other"]),
        ]
        for (original, goal, extra) in cases {
            let recorder = PurchaseRecorder()
            do {
                _ = try await FounderData.trackPurchase(product: "pro_monthly", source: .gate("Stats"), send: recorder.send) {
                    throw original
                }
                Issue.record("\(original) was not thrown again")
            } catch {
                #expect(String(reflecting: error) == String(reflecting: original), "a different error came back")
            }
            #expect(recorder.names == ["purchase_start", goal], "\(original)")
            #expect(recorder.goals.last?.props == ["source": "gate_stats", "product": "pro_monthly"].merging(extra) { $1 })
        }
    }

    @Test func failureReasonSortsRevenueCatErrors() {
        #expect(FounderData.PurchaseFailureReason(NSError(domain: "RevenueCat.ErrorCode", code: 10)) == .network)
        #expect(FounderData.PurchaseFailureReason(NSError(domain: "RevenueCat.ErrorCode", code: 5)) == .store)
        #expect(FounderData.PurchaseFailureReason(NSError(domain: "SomethingElse", code: 10)) == .other)
    }

    /// The closure runs on the caller's actor, so a view model on the main actor can use its own state.
    @MainActor
    @Test func runsOnTheCallersActor() async {
        let model = MainActorModel()
        let outcome = await FounderData.trackPurchase(product: "p", source: .settings, send: { _ in }) {
            model.unlocked = true
            return .purchased
        }
        #expect(outcome == .purchased)
        #expect(model.unlocked)
    }
}

@MainActor
private final class MainActorModel {
    var unlocked = false
}
