import Foundation
import Security
import Testing
@testable import FounderDataKit

/// Without consent the SDK stores nothing on the device (EU ePrivacy rules). With consent it keeps
/// the install id in the Keychain and the queue in a file, and withdrawing consent deletes both.
@Suite("Consent and on-device storage", .serialized)
struct ConsentTests {
    private let launchId = "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"

    @Test func memoryModeWritesNoFile() async throws {
        let h = Harness(persistent: false)
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        h.core.record(.goal("signup", ["plan": "pro"]))
        h.core.appEnteredBackground()
        h.core.saveNow()
        h.transport.script([-1])
        await h.core.flush(ignoreBackoff: true)
        #expect(h.queued.count > 0)
        #expect(!FileManager.default.fileExists(atPath: h.directory.path))
        #expect(!h.core.isPersistent)
    }

    @Test func consentKeepsTheCurrentIdsAndStartsSaving() throws {
        let h = Harness(persistent: false)
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        let sid = try #require(h.core.snapshot.session.sessionId)
        let store = StateStore(fileURL: h.stateFile)
        h.core.enablePersistence(store: store, installId: launchId)
        h.core.record(.screen("Settings"))
        h.core.saveNow()
        #expect(h.core.snapshot.session.sessionId == sid)
        #expect(Set(h.queued.map(\.sid)) == [sid])
        #expect(store.load()?.queue.count == h.core.snapshot.queue.count)
    }

    @Test func consentWithAStoredInstallIdContinuesUnderItInANewSession() throws {
        let h = Harness(persistent: false)
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        let firstSid = try #require(h.core.snapshot.session.sessionId)
        let stored = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"
        h.core.enablePersistence(store: StateStore(fileURL: h.stateFile), installId: stored)
        h.core.record(.screen("Settings"))
        let items = h.core.snapshot.queue.items
        #expect(h.core.installId == stored)
        #expect(items.last?.vid == stored)
        #expect(items.last?.event.sid != firstSid)
        #expect(items.first?.vid == launchId)
    }

    @Test func withdrawingConsentDeletesTheFileAndChangesTheId() throws {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        h.core.saveNow()
        #expect(FileManager.default.fileExists(atPath: h.stateFile.path))
        h.core.disablePersistence(installId: "11111111-2222-4333-8444-555555555555")
        h.core.record(.screen("Settings"))
        h.core.saveNow()
        #expect(!FileManager.default.fileExists(atPath: h.stateFile.path))
        #expect(h.core.snapshot.queue.items.last?.vid == "11111111-2222-4333-8444-555555555555")
    }

    @Test func eraseRemovesTheQueueFolder() throws {
        let base = FileManager.default.temporaryDirectory.appendingPathComponent("founderdata-tests-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        StateStore.inDirectory(base).save(PersistedState())
        StateStore.eraseAll(in: base)
        #expect(!FileManager.default.fileExists(atPath: base.appendingPathComponent("FounderData").path))
    }

    /// The public API end to end, as an app uses it without consent.
    @Test func publicApiWithoutConsentStoresNothing() async throws {
        let support = try #require(FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first)
        StateStore.eraseAll()
        InstallIDStore.shared.erase()
        let keychainWorks = keychainIsAvailable()
        let callsBefore = InstallIDStore.shared.keychainCalls

        FounderData.configure(siteId: "site_consent_test", host: "http://127.0.0.1:9")
        FounderData.screen("Home")
        FounderData.goal("onboarding_complete")
        FounderData.identify(userId: "u_1")
        let token = FounderData.appAccountToken
        let core = try #require(FounderData.current)
        core.appEnteredBackground()
        await core.flush(ignoreBackoff: true)
        core.saveNow()

        #expect(InstallIDStore.shared.keychainCalls == callsBefore)
        #expect(!FounderData.hasConsent)
        #expect(!core.isPersistent)
        #expect(token.uuidString.lowercased() == core.installId)
        #expect(!FileManager.default.fileExists(atPath: support.appendingPathComponent("FounderData").path))
        let defaults = UserDefaults.standard.dictionaryRepresentation().keys
        #expect(!defaults.contains { $0.hasPrefix("founderdata.") })
        if keychainWorks {
            #expect(keychainStatus("app.founderdata") == errSecItemNotFound)
        }
        print("ConsentTests: Keychain available in this test run: \(keychainWorks)")
    }

    /// `reset()` without consent changes the id in memory and touches no storage.
    @Test func publicResetWithoutConsentStoresNothing() throws {
        let callsBefore = InstallIDStore.shared.keychainCalls
        FounderData.configure(siteId: "site_consent_test", host: "http://127.0.0.1:9")
        let before = FounderData.appAccountToken
        FounderData.reset()
        let after = FounderData.appAccountToken
        #expect(before != after)
        #expect(try #require(FounderData.current).installId == after.uuidString.lowercased())
        #expect(FounderData.revenueCatAttributes == ["founderDataVisitorId": after.uuidString.lowercased()])
        #expect(InstallIDStore.shared.keychainCalls == callsBefore)
        #expect(!FounderData.hasConsent)
    }

    private func keychainStatus(_ service: String) -> OSStatus {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "install_id",
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        return SecItemCopyMatching(query as CFDictionary, nil)
    }

    /// Adds and removes a probe item, so a "not found" result means something.
    private func keychainIsAvailable() -> Bool {
        let probe: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "founderdata.test.probe.\(UUID().uuidString)",
            kSecAttrAccount as String: "probe",
        ]
        var add = probe
        add[kSecValueData as String] = Data("1".utf8)
        guard SecItemAdd(add as CFDictionary, nil) == errSecSuccess else { return false }
        SecItemDelete(probe as CFDictionary)
        return true
    }
}
