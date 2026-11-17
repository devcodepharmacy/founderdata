import Foundation

/// Analytics and App Store revenue for a FounderData site.
///
/// Call `configure(siteId:host:)` once, in your `App` initializer. Every other
/// call is safe from any thread and does nothing until then.
///
/// By default the SDK stores nothing on the device: the install id and the session
/// are random per app launch, and the event queue lives in memory. After
/// `setConsent(true)` it keeps the install id in the Keychain and the queue in a file.
/// `configure(..., installId: .vendor)` keeps one id per install without consent, derived
/// from `identifierForVendor`.
public enum FounderData {
    private static let core = Locked<Core?>(nil)

    /// Consent and opt-out live in memory. The app persists its own settings and passes
    /// them in on each launch.
    private struct Settings {
        var consent = false
        var enabled = true
        var launchId = UUID().uuidString.lowercased()
        var sessionProperties: [String: String] = [:]
        /// The `.vendor` install id, set by `configure`. Nil in `.perLaunch` mode.
        var vendorId: String?
    }
    private static let settings = Locked(Settings())

    static var current: Core? { core.withLock { $0 } }

    /// Starts the SDK.
    ///
    /// - Parameters:
    ///   - siteId: The site id from the FounderData dashboard.
    ///   - host: Where your FounderData Worker runs, for example `"https://founderdata.example.com"`.
    ///   - debugHost: Used instead of `host` when the app is built in the Debug configuration.
    ///   - installId: The id without consent. `.perLaunch` (default) is random for each launch. `.vendor` is a
    ///     hash of `identifierForVendor` and the site id, the same on every launch, so retention covers the install.
    ///     With consent the Keychain id wins in both modes.
    ///
    /// An empty site id, a host that is not a URL, or a host on plain `http` other than `localhost` or the local
    /// network is logged as an error and, in Debug builds, stops the app at an `assertionFailure`.
    public static func configure(siteId: String, host: String, debugHost: String? = nil, installId mode: InstallIDMode = .perLaunch) {
        for problem in configurationProblems(siteId: siteId, host: host, debugHost: debugHost) {
            sdkLog.error("FounderData.configure: \(problem, privacy: .public)")
            #if DEBUG
            assertionFailure("FounderData.configure: \(problem)")
            #endif
        }
        #if DEBUG
        let chosenHost = debugHost ?? host
        #else
        let chosenHost = host
        #endif
        guard let endpoint = Endpoint.events(host: chosenHost), let site = siteId.clipped(64) else { return }
        // Read before taking a lock: it may wait for the main thread.
        let vendorId = mode == .vendor ? VendorInstallID.current(siteId: site) : nil
        if mode == .vendor, vendorId == nil {
            sdkLog.notice("FounderData: identifierForVendor is not available yet, this launch uses a random install id")
        }
        let created: Core? = core.withLock { existing in
            guard existing == nil else { return nil }
            let (consent, enabled, launchId, properties) = settings.withLock { s in
                s.vendorId = vendorId
                return (s.consent, s.enabled, s.launchId, s.sessionProperties)
            }
            let instance = Core(configuration: Core.Configuration(
                siteId: site,
                endpoint: endpoint,
                installId: startingInstallId(consent: consent, launchId: launchId, vendorId: vendorId, keychain: InstallIDStore.shared.adopt),
                context: DeviceContext.current(),
                store: consent ? StateStore.applicationSupport() : nil,
                transport: URLSessionTransport(),
                enabled: enabled,
                sessionProperties: properties,
                vendorInstallId: vendorId
            ))
            existing = instance
            return instance
        }
        guard let created else {
            sdkLog.notice("FounderData.configure was called more than once; the first call wins")
            return
        }
        start(created)
        // A session restored from the queue file gets the properties set before this call.
        let properties = settings.withLock { $0.sessionProperties }
        if !properties.isEmpty { created.setSessionProperties(properties) }
    }

    /// The id a launch starts with. Consent: the Keychain id, or else the vendor id or launch id, which is then
    /// stored. Without consent: the vendor id in `.vendor` mode (`vendorId` set), otherwise the launch id.
    static func startingInstallId(consent: Bool, launchId: String, vendorId: String?, keychain: (String) -> String) -> String {
        let candidate = vendorId ?? launchId
        return consent ? keychain(candidate) : candidate
    }

    /// Records a screen view. The server stores it as a page view with path `/` + `name`.
    public static func screen(_ name: String) {
        var trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasPrefix("/") { trimmed.removeFirst() }
        guard let clipped = trimmed.clipped(200) else { return }
        current?.record(.screen(clipped))
    }

    /// Records a goal (conversion), with optional string properties.
    ///
    /// Use `onboarding_<step>` for each onboarding step and `onboarding_complete`
    /// at the end, so onboarding funnels line up across apps.
    public static func goal(_ name: String, props: [String: String] = [:]) {
        guard let clipped = name.clipped(100) else { return }
        current?.record(.goal(clipped, cleanedProps(props)))
    }

    // MARK: Session properties, experiments, onboarding

    /// At most this many session properties are kept. Further keys are dropped.
    public static let maxSessionProperties = 10

    /// Sets small properties on the current session and on every later session of this launch,
    /// for example `["user_state": "returning", "onboarding_variant": "b", "build_channel": "testflight"]`.
    ///
    /// Keys become lowercase `a-z`, `0-9` and `_`, at most 40 characters. Values are cut at 100
    /// characters. An empty value removes the key. Calls merge into the properties set so far; keys
    /// beyond `maxSessionProperties` are dropped. A session that already started gets the new set
    /// through one extra event; a value that did not change sends nothing. Nothing is stored on the
    /// device: set the properties again on every launch, ideally right after `configure`.
    public static func setSessionProperties(_ properties: [String: String]) {
        let merged: [String: String] = settings.withLock { s in
            s.sessionProperties = mergedSessionProperties(s.sessionProperties, properties)
            return s.sessionProperties
        }
        current?.setSessionProperties(merged)
    }

    /// The session properties set so far in this launch.
    public static var sessionProperties: [String: String] { settings.withLock { $0.sessionProperties } }

    /// Records which variant of an experiment this launch sees, as the session property
    /// `exp_<name>`. `FounderData.experiment("paywall_copy", variant: "b")` sets `exp_paywall_copy = b`.
    /// It counts toward the 10 session properties.
    public static func experiment(_ name: String, variant: String) {
        guard let key = propertyKey(name, maxLength: 36) else { return }
        setSessionProperties(["exp_" + key: variant])
    }

    /// Records that the user reached onboarding step `index` (1 for the first step) named `name`.
    /// Sends the goal `onboarding_<name>` with the props `step` (the name) and `index`. The dashboard
    /// builds the onboarding funnel from these goals, ordered by `index`. The name becomes lowercase
    /// `a-z`, `0-9` and `_`: `onboardingStep(2, "Notifications")` sends `onboarding_notifications`.
    public static func onboardingStep(_ index: Int, _ name: String) {
        guard let goal = onboardingGoal(index, name) else { return }
        current?.record(goal)
    }

    static func onboardingGoal(_ index: Int, _ name: String) -> Core.Action? {
        guard let step = propertyKey(name, maxLength: 53) else { return nil }
        return .goal("onboarding_" + step, ["step": step, "index": String(index)])
    }

    /// Records that the user finished onboarding: the goal `onboarding_complete`.
    public static func onboardingComplete() {
        current?.record(.goal("onboarding_complete", [:]))
    }

    /// Lowercase `a-z`, `0-9` and `_`; other characters become `_`, leading and trailing `_` are removed.
    static func propertyKey(_ raw: String, maxLength: Int = 40) -> String? {
        var out = ""
        for ch in raw.lowercased().unicodeScalars {
            let ok = (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch == "_"
            out.unicodeScalars.append(ok ? ch : "_")
        }
        while out.hasPrefix("_") { out.removeFirst() }
        while out.hasSuffix("_") { out.removeLast() }
        guard !out.isEmpty else { return nil }
        return String(out.prefix(maxLength))
    }

    static func mergedSessionProperties(_ current: [String: String], _ update: [String: String]) -> [String: String] {
        var out = current
        for (rawKey, rawValue) in update.sorted(by: { $0.key < $1.key }) {
            guard let key = propertyKey(rawKey) else { continue }
            guard let value = rawValue.clipped(100) else {
                out[key] = nil
                continue
            }
            if out[key] == nil, out.count >= maxSessionProperties {
                sdkLog.notice("FounderData keeps \(maxSessionProperties, privacy: .public) session properties, dropped one")
                continue
            }
            out[key] = value
        }
        return out
    }

    /// Links this install to your own user record. Call it after sign-in.
    /// Until you call it, the data stays anonymous.
    public static func identify(userId: String?, email: String? = nil, name: String? = nil) {
        let user = userId?.clipped(128)
        let mail = email?.clipped(200)
        let display = name?.clipped(128)
        guard user != nil || mail != nil || display != nil else { return }
        current?.record(.identify(userId: user, email: mail, name: display))
    }

    /// Call it when the user signs out. The next events go out under a new install id in a new session,
    /// so the next person on this device is not linked to the user from `identify()`.
    ///
    /// Without consent the new id is random and lives in memory, like the launch id. In `.vendor` mode that
    /// random id lasts until the app quits; the next launch is back under the vendor id. With consent the SDK
    /// replaces the id in the Keychain, so the new id lasts across launches. `appAccountToken` changes with
    /// it. Session properties, consent and `isEnabled` stay as they are.
    public static func reset() {
        let fresh = UUID().uuidString.lowercased()
        let id: String
        if hasConsent {
            InstallIDStore.shared.erase()
            id = InstallIDStore.shared.adopt(fresh)
        } else {
            id = fresh
        }
        settings.withLock { $0.launchId = id }
        current?.resetIdentity(installId: id)
    }

    /// Reads campaign parameters (`utm_*`, `ref`) and a web visitor id (`rt_vid`, or the older `ml_vid`) from a
    /// deep link or universal link. Returns true when the link carried any of them.
    @discardableResult
    public static func handle(url: URL) -> Bool {
        guard let source = LinkAttribution.source(from: url) else { return false }
        current?.attach(linkSource: source)
        return true
    }

    /// The install id as a UUID. Pass it to `product.purchase(options: [.appAccountToken(...)])`
    /// so App Store Server Notifications can be credited to this install.
    ///
    /// Without consent it is the id of the current launch (the vendor id in `.vendor` mode), which links a
    /// purchase to the session it happened in. Renewals then match through the original transaction id.
    public static var appAccountToken: UUID {
        if let core = current { return UUID(uuidString: core.installId) ?? UUID() }
        let (consent, launchId) = settings.withLock { ($0.consent, $0.launchId) }
        let id = consent ? InstallIDStore.shared.adopt(launchId) : launchId
        return UUID(uuidString: id) ?? UUID()
    }

    /// Whether the user agreed to on-device storage. Not stored by the SDK.
    public static var hasConsent: Bool { settings.withLock { $0.consent } }

    /// Turns on-device storage on or off. Call it with the user's stored choice before
    /// `configure` on every launch, and again whenever the user changes it.
    ///
    /// - `true`: the install id goes to the Keychain and the queue to a file in Application
    ///   Support, so an install keeps one id across launches and unsent events survive a
    ///   termination. An install id stored by an earlier consent is used again; otherwise the
    ///   current launch's id is kept, so the visit continues.
    /// - `false`: deletes the Keychain item and the queue file and continues in memory under a
    ///   new random id, or under the vendor id in `.vendor` mode.
    public static func setConsent(_ granted: Bool) {
        let wasGranted: Bool = settings.withLock { s in
            defer { s.consent = granted }
            return s.consent
        }
        if granted {
            guard let core = current, !core.isPersistent, let store = StateStore.applicationSupport() else { return }
            core.enablePersistence(store: store, installId: InstallIDStore.shared.adopt(core.installId))
        } else {
            if wasGranted {
                let next: String = settings.withLock { s in
                    s.launchId = s.vendorId ?? UUID().uuidString.lowercased()
                    return s.launchId
                }
                current?.disablePersistence(installId: next)
            }
            InstallIDStore.shared.erase()
            StateStore.eraseAll()
        }
    }

    /// Opt-out switch, kept in memory for this launch. Setting it to false drops every queued
    /// event and stops all collection until it is set back to true. To make an opt-out last,
    /// store it in the app and set this before `configure` on every launch.
    public static var isEnabled: Bool {
        get { settings.withLock { $0.enabled } }
        set {
            settings.withLock { $0.enabled = newValue }
            current?.setEnabled(newValue)
        }
    }

    /// Uploads the queued events now and returns how many the server accepted. Use it in tests, or before the
    /// app exits on purpose. The SDK uploads on its own every 30 seconds, on background and after a purchase.
    ///
    /// It skips the wait that follows a failed upload. It returns 0 without sending when nothing is queued,
    /// before `configure`, while another upload runs, or while the first upload of a launch waits for the
    /// Apple Ads token (at most 10 seconds).
    @discardableResult
    public static func flush() async -> Int {
        await flush(current)
    }

    static func flush(_ core: Core?) async -> Int {
        guard let core else { return 0 }
        return await core.flush(ignoreBackoff: true)
    }

    // MARK: Configuration checks

    /// What is wrong with the arguments of `configure`, one sentence each. Empty when they are fine.
    static func configurationProblems(siteId: String, host: String, debugHost: String?) -> [String] {
        var problems: [String] = []
        if siteId.clipped(64) == nil {
            problems.append("the site id is empty. Copy it from the site's Settings in the FounderData dashboard.")
        }
        for (name, value) in [("host", host), ("debugHost", debugHost)] {
            guard let value, let problem = hostProblem(value) else { continue }
            problems.append("\(name) \"\(value)\" \(problem)")
        }
        return problems
    }

    /// Nil for an https URL, or an http URL on this Mac or the local network.
    static func hostProblem(_ host: String) -> String? {
        guard let url = Endpoint.events(host: host) else { return "is not a URL." }
        switch url.scheme?.lowercased() ?? "" {
        case "https":
            return nil
        case "http" where isLocalHost(url.host() ?? ""):
            return nil
        default:
            return "needs https. Plain http works only for localhost, *.local and private network addresses."
        }
    }

    /// `localhost`, `*.local`, loopback and private IPv4 addresses (10/8, 172.16/12, 192.168/16).
    static func isLocalHost(_ host: String) -> Bool {
        let name = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        if name == "localhost" || name == "::1" || name.hasSuffix(".local") { return true }
        let octets = name.split(separator: ".", omittingEmptySubsequences: false)
        let parts = octets.compactMap { UInt8($0) }
        guard octets.count == 4, parts.count == 4 else { return false }
        switch (parts[0], parts[1]) {
        case (127, _), (10, _), (192, 168): return true
        case (172, 16...31): return true
        default: return false
        }
    }

    /// The server stores props as JSON cut at 1,000 characters, and a cut JSON string
    /// is unreadable. Keep at most 20 props and stay under that size.
    static func cleanedProps(_ props: [String: String]) -> [String: String] {
        var cleaned: [String: String] = [:]
        var size = 2
        for (key, value) in props.sorted(by: { $0.key < $1.key }) {
            guard cleaned.count < 20, let k = key.clipped(64), let v = value.clipped(256) else { continue }
            let entry = (try? JSONEncoder().encode([k: v]).count) ?? 1_000
            guard size + entry - 1 <= 1_000 else { continue }
            size += entry - 1
            cleaned[k] = v
        }
        return cleaned
    }

    // MARK: Startup

    private static func start(_ core: Core) {
        if core.needsAdsToken {
            core.holdForAdsToken()
            Task.detached(priority: .utility) {
                core.resolveAdsToken(AdsAttribution.token())
                await core.flush()
            }
        }
        NetworkWatcher.shared.start(core: core)
        #if canImport(UIKit)
        if Thread.isMainThread {
            MainActor.assumeIsolated { LifecycleObserver.install(core: core) }
        } else {
            Task { @MainActor in LifecycleObserver.install(core: core) }
        }
        #endif
    }
}
