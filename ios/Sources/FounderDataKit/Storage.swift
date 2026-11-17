import Foundation
import os
import Security

let sdkLog = Logger(subsystem: "app.founderdata.kit", category: "FounderDataKit")

/// `PrivacyInfo.xcprivacy` in the package's resource bundle, where Xcode's privacy report reads it.
enum PrivacyManifest {
    static var url: URL? { Bundle.module.url(forResource: "PrivacyInfo", withExtension: "xcprivacy") }
}

/// Everything the SDK keeps between launches, in one JSON file.
struct PersistedState: Codable, Equatable, Sendable {
    var version = 1
    var queue = EventQueue()
    var session = SessionState()
    var pendingSource: WireSource?
    var adsTokenResolved = false
    var reportedTransactions: [String] = []
}

/// Reads and writes `Application Support/FounderData/state.json`.
struct StateStore: Sendable {
    let fileURL: URL

    static func applicationSupport() -> StateStore? {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        ) else { return nil }
        return inDirectory(base)
    }

    /// Deletes the queue file without creating anything.
    static func eraseAll() {
        guard let base = try? FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: false
        ) else { return }
        eraseAll(in: base)
    }

    static func eraseAll(in base: URL) {
        try? FileManager.default.removeItem(at: base.appendingPathComponent("FounderData", isDirectory: true))
    }

    /// The store under `base/FounderData`.
    static func inDirectory(_ base: URL) -> StateStore {
        var dir = base.appendingPathComponent("FounderData", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("state.json")
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? dir.setResourceValues(values)
        return StateStore(fileURL: file)
    }

    func load() -> PersistedState? {
        guard let data = try? Data(contentsOf: fileURL) else { return nil }
        do {
            return try JSONDecoder().decode(PersistedState.self, from: data)
        } catch {
            sdkLog.error("FounderData state file unreadable, starting empty")
            return nil
        }
    }

    func save(_ state: PersistedState) {
        do {
            try FileManager.default.createDirectory(
                at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
            )
            let data = try JSONEncoder().encode(state)
            try data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        } catch {
            sdkLog.error("FounderData could not save its queue: \(error.localizedDescription, privacy: .public)")
        }
    }

    func delete() {
        try? FileManager.default.removeItem(at: fileURL)
    }
}

/// The persistent install id, used only after consent (`FounderData.setConsent(true)`): a random UUID v4
/// in the Keychain (kSecAttrAccessibleAfterFirstUnlock, not synced), so it survives reinstalls on the
/// same device. A copy in UserDefaults covers a Keychain that cannot be read yet (for example a launch
/// before first unlock). Without consent the SDK never creates this store's items.
final class InstallIDStore: Sendable {
    static let shared = InstallIDStore()

    private let service: String
    private let account = "install_id"
    private let mirrorKey: String
    private let suiteName: String?
    private let cache = OSAllocatedUnfairLock<String?>(initialState: nil)
    private let calls = OSAllocatedUnfairLock(initialState: 0)

    /// How often this store called the Keychain. Tests use it to prove the default mode never does.
    var keychainCalls: Int { calls.withLock { $0 } }

    init(service: String = "app.founderdata", mirrorKey: String = "founderdata.installId", suiteName: String? = nil) {
        self.service = service
        self.mirrorKey = mirrorKey
        self.suiteName = suiteName
    }

    private var defaults: UserDefaults { suiteName.flatMap(UserDefaults.init(suiteName:)) ?? .standard }

    /// Lowercase UUID with dashes, the same form App Store JWS payloads use for `appAccountToken`.
    /// Reads the stored id, or stores a new random one.
    var value: String { adopt(UUID().uuidString.lowercased()) }

    /// The stored id if the device has one, otherwise stores
    /// `candidate` and returns it.
    func adopt(_ candidate: String) -> String {
        cache.withLock { cached in
            if let cached { return cached }
            let id = loadOrCreate(candidate: Self.normalized(candidate) ?? candidate)
            cached = id
            return id
        }
    }

    /// Deletes the Keychain item and the UserDefaults copy.
    func erase() {
        cache.withLock { cached in
            cached = nil
            deleteKeychain(service)
            if defaults.object(forKey: mirrorKey) != nil { defaults.removeObject(forKey: mirrorKey) }
        }
    }

    private func loadOrCreate(candidate: String) -> String {
        let defaults = self.defaults
        let mirror = defaults.string(forKey: mirrorKey).flatMap(Self.normalized)
        let id: String
        switch readKeychain(service) {
        case .found(let found):
            id = found
        case .notFound:
            id = mirror ?? candidate
            writeKeychain(id)
        case .unavailable:
            id = mirror ?? candidate
        }
        if defaults.string(forKey: mirrorKey) != id { defaults.set(id, forKey: mirrorKey) }
        return id
    }

    private enum ReadResult { case found(String), notFound, unavailable }

    private func baseQuery(_ service: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
        ]
    }

    private func readKeychain(_ service: String) -> ReadResult {
        calls.withLock { $0 += 1 }
        var query = baseQuery(service)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        switch status {
        case errSecSuccess:
            if let data = item as? Data, let raw = String(data: data, encoding: .utf8), let id = Self.normalized(raw) {
                return .found(id)
            }
            return .notFound
        case errSecItemNotFound:
            return .notFound
        default:
            return .unavailable
        }
    }

    @discardableResult
    private func writeKeychain(_ id: String) -> Bool {
        calls.withLock { $0 += 1 }
        SecItemDelete(baseQuery(service) as CFDictionary)
        var attributes = baseQuery(service)
        attributes[kSecValueData as String] = Data(id.utf8)
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status != errSecSuccess {
            sdkLog.error("FounderData could not store the install id in the Keychain (\(status, privacy: .public))")
        }
        return status == errSecSuccess
    }

    private func deleteKeychain(_ service: String) {
        calls.withLock { $0 += 1 }
        SecItemDelete(baseQuery(service) as CFDictionary)
    }

    static func normalized(_ raw: String) -> String? {
        UUID(uuidString: raw.trimmingCharacters(in: .whitespacesAndNewlines))?.uuidString.lowercased()
    }
}
