import Foundation

/// Thread-safe engine behind the public `FounderData` API.
///
/// Every public call takes the lock once, updates the session and the queue
/// synchronously (so event order is call order), then schedules a coalesced
/// write of the state file. Delivery runs async and never holds the lock
/// across a network call.
///
/// Without a store (the default, no consent) the queue and the session live in
/// memory only and nothing is written to the device. `enablePersistence` and
/// `disablePersistence` switch between the two modes at runtime.
final class Core: Sendable {
    struct Configuration: Sendable {
        var siteId: String
        var endpoint: URL
        /// The install id events start with. Persistent mode: the Keychain id. Default mode: random per launch.
        var installId: String
        var context: WireContext
        /// Where the queue is saved. Nil keeps everything in memory.
        var store: StateStore?
        var transport: any Transport
        var now: @Sendable () -> Date = { Date() }
        var enabled = true
        var jitter: @Sendable () -> Double = { Double.random(in: 0.8...1.2) }
        var makeSessionId: @Sendable () -> String = { UUID().uuidString.lowercased() }
        /// Delay before a scheduled save is written. Lifecycle events write at once.
        var saveDelay: TimeInterval = 1
        /// Send a purchase right away instead of waiting for the next timer tick.
        var flushAfterPurchase = true
        /// Session properties set before `configure`.
        var sessionProperties: [String: String] = [:]
        /// The `.vendor` install id, when the app chose that mode. Events under it without consent carry `ctx.id`.
        var vendorInstallId: String? = nil
    }

    enum Action: Sendable {
        case screen(String)
        case goal(String, [String: String])
        case identify(userId: String?, email: String?, name: String?)
        case purchase(jws: String, dedupeKey: String)
    }

    /// A link that arrives this soon after a session started fills that session's `src`
    /// (cold launch from a link) instead of starting another session.
    static let sourceMergeWindow: TimeInterval = 60
    /// Longest wait for the first-launch Apple Ads token before the first batch leaves.
    static let adsTokenWait: TimeInterval = 10
    static let maxReportedTransactions = 200

    struct State: Sendable {
        var installId: String
        var store: StateStore?
        var queue = EventQueue()
        var session: SessionTracker
        var pendingSource: WireSource?
        var adsTokenResolved = false
        var reportedTransactions: [String] = []
        /// Launch-scoped session properties: every new session starts with them. Kept in memory only.
        var sessionProperties: [String: String] = [:]
        var enabled: Bool
        var flushing = false
        var failures = 0
        var nextAttemptAt: Date?
        var holdFlushUntil: Date?
        var saveScheduled = false

        var persisted: PersistedState {
            PersistedState(
                queue: queue,
                session: session.state,
                pendingSource: pendingSource,
                adsTokenResolved: adsTokenResolved,
                reportedTransactions: reportedTransactions
            )
        }
    }

    let config: Configuration
    private let state: Locked<State>
    private let io = DispatchQueue(label: "app.founderdata.io", qos: .utility)

    init(configuration: Configuration) {
        config = configuration
        var initial = State(
            installId: configuration.installId,
            store: configuration.store,
            session: SessionTracker(makeId: configuration.makeSessionId),
            sessionProperties: configuration.sessionProperties,
            enabled: configuration.enabled
        )
        if configuration.enabled, let stored = configuration.store?.load() {
            initial.queue = stored.queue
            initial.session.state = stored.session
            initial.session.relaunched()
            initial.pendingSource = stored.pendingSource
            initial.adsTokenResolved = stored.adsTokenResolved
            initial.reportedTransactions = stored.reportedTransactions
            initial.queue.purgeExpired(nowMs: configuration.now().unixMs)
        } else if !configuration.enabled {
            configuration.store?.delete()
        }
        state = Locked(initial)
    }

    // MARK: Events

    func record(_ action: Action) {
        let now = config.now()
        let isPurchase: Bool = state.withLock { s in
            guard s.enabled else { return false }
            var purchase = false
            if case .purchase(_, let key) = action {
                if s.reportedTransactions.contains(key) { return false }
                s.reportedTransactions.append(key)
                if s.reportedTransactions.count > Self.maxReportedTransactions {
                    s.reportedTransactions.removeFirst(s.reportedTransactions.count - Self.maxReportedTransactions)
                }
                purchase = true
            }
            let (sid, start) = s.session.ensureSession(at: now, source: s.pendingSource)
            if let start {
                s.pendingSource = nil
                enqueue(start, into: &s)
            }
            enqueue(Self.event(for: action, sid: sid, at: now), into: &s)
            return purchase
        }
        scheduleSave()
        if isPurchase, config.flushAfterPurchase {
            Task.detached(priority: .utility) { [self] in await flush() }
        }
    }

    /// A deep link or universal link with attribution parameters.
    func attach(linkSource source: WireSource) {
        let now = config.now()
        state.withLock { s in
            guard s.enabled else { return }
            if let sid = s.session.sessionId, !s.session.isExpired(at: now),
               let started = s.session.state.startedAt,
               now.timeIntervalSince(started) < Self.sourceMergeWindow,
               s.queue.mergeSource(source, intoSessionStartOf: sid) {
                return
            }
            for ping in s.session.closeForRestart(at: now) { enqueue(ping, into: &s) }
            let merged = (s.pendingSource ?? WireSource()).merging(source)
            s.pendingSource = nil
            enqueue(s.session.startSession(at: now, source: merged).start, into: &s)
        }
        scheduleSave()
    }

    /// The app changed its session properties (`props` is the full set). A running session gets them on its
    /// queued `session_start`, or else through one `session_props` event. Unchanged values send nothing.
    func setSessionProperties(_ props: [String: String]) {
        let now = config.now()
        let changed: Bool = state.withLock { s in
            s.sessionProperties = props
            guard s.enabled, let sid = s.session.sessionId, !s.session.isExpired(at: now) else { return false }
            guard (s.session.state.properties ?? [:]) != props else { return false }
            s.session.state.properties = props
            if s.queue.setSessionProperties(props, intoSessionStartOf: sid) { return true }
            enqueue(WireEvent(t: .sessionProps, sid: sid, ts: now.unixMs, p: props), into: &s)
            return true
        }
        if changed { scheduleSave() }
    }

    // MARK: Apple Ads token

    var needsAdsToken: Bool { state.withLock { $0.enabled && !$0.adsTokenResolved } }

    /// Holds delivery for up to 10 seconds so the token can join the first `session_start`.
    func holdForAdsToken() {
        let until = config.now().addingTimeInterval(Self.adsTokenWait)
        state.withLock { $0.holdFlushUntil = until }
    }

    func resolveAdsToken(_ token: String?) {
        state.withLock { s in
            s.adsTokenResolved = true
            s.holdFlushUntil = nil
            guard s.enabled, let token, !token.isEmpty else { return }
            let source = WireSource(adsToken: token)
            if let sid = s.session.sessionId, s.queue.mergeSource(source, intoSessionStartOf: sid) { return }
            s.pendingSource = (s.pendingSource ?? WireSource()).merging(source)
        }
        scheduleSave()
    }

    // MARK: Lifecycle

    func appBecameActive() {
        let now = config.now()
        state.withLock { s in
            guard s.enabled else { return }
            if let start = s.session.becameActive(at: now, source: s.pendingSource) {
                s.pendingSource = nil
                enqueue(start, into: &s)
            }
        }
        scheduleSave()
    }

    func appResignedActive() {
        let now = config.now()
        state.withLock { s in
            guard s.enabled else { return }
            s.session.resignedActive(at: now)
        }
    }

    func appEnteredBackground() {
        let now = config.now()
        state.withLock { s in
            guard s.enabled else { return }
            for ping in s.session.enteredBackground(at: now) { enqueue(ping, into: &s) }
        }
        saveNow()
    }

    /// 30-second timer while active.
    func tick() {
        let now = config.now()
        let added: Bool = state.withLock { s in
            guard s.enabled else { return false }
            let pings = s.session.tick(at: now)
            for ping in pings { enqueue(ping, into: &s) }
            return !pings.isEmpty
        }
        if added { scheduleSave() }
    }

    // MARK: Consent

    var installId: String { state.withLock { $0.installId } }
    var isPersistent: Bool { state.withLock { $0.store != nil } }

    /// Consent given: from now on the queue is saved to `store`. When the device already holds an
    /// install id from an earlier consent (`storedInstallId` differs from the current id), events
    /// continue under that id in a new session; otherwise the current ids stay, so the visit
    /// continues. A queue file left by an earlier consented launch is picked up.
    func enablePersistence(store: StateStore, installId newId: String) {
        let now = config.now()
        let stored = store.load()
        state.withLock { s in
            s.store = store
            guard s.enabled else { return }
            if newId != s.installId { restart(as: newId, at: now, in: &s) }
            if let stored {
                var merged = EventQueue()
                for item in stored.queue.items + s.queue.items {
                    merged.append(item.event, vid: item.vid, ctx: item.ctx)
                }
                merged.purgeExpired(nowMs: now.unixMs)
                s.queue = merged
                s.adsTokenResolved = s.adsTokenResolved || stored.adsTokenResolved
                s.reportedTransactions = Array((stored.reportedTransactions + s.reportedTransactions).suffix(Self.maxReportedTransactions))
            }
        }
        saveNow()
    }

    /// Consent withdrawn: nothing is saved any more, and events continue in memory under
    /// `installId` (a new random id) in a new session. The caller deletes the stored data.
    func disablePersistence(installId newId: String) {
        let now = config.now()
        let old: StateStore? = state.withLock { s in
            defer { s.store = nil }
            return s.store
        }
        // On the io queue, so a save already scheduled cannot write the file again afterwards.
        io.sync { old?.delete() }
        state.withLock { s in
            s.store = nil
            s.saveScheduled = false
            restart(as: newId, at: now, in: &s)
        }
    }

    // MARK: Reset

    /// The user signed out (`FounderData.reset()`): events continue under `installId` (a new id) in a new
    /// session. Events already queued keep the id they were recorded with. The store, if any, stays.
    func resetIdentity(installId newId: String) {
        let now = config.now()
        state.withLock { s in restart(as: newId, at: now, in: &s) }
        saveNow()
    }

    /// Reports the open engaged time under the old id, then switches to `newId` with no session running.
    private func restart(as newId: String, at now: Date, in s: inout State) {
        guard s.enabled else {
            s.installId = newId
            return
        }
        for ping in s.session.closeForRestart(at: now) { enqueue(ping, into: &s) }
        s.session.end()
        s.installId = newId
    }

    // MARK: Opt-out

    var isEnabled: Bool { state.withLock { $0.enabled } }

    func setEnabled(_ enabled: Bool) {
        state.withLock { s in
            s.enabled = enabled
            if !enabled {
                s.queue.removeAll()
                s.session = SessionTracker(makeId: config.makeSessionId)
                s.pendingSource = nil
                s.holdFlushUntil = nil
                s.failures = 0
                s.nextAttemptAt = nil
            }
        }
        saveNow()
    }

    // MARK: Delivery

    /// Sends queued events in batches until the queue is empty or a request fails.
    /// `ignoreBackoff` is for the last chance before suspension and for network return.
    /// Returns the number of events the server accepted.
    @discardableResult
    func flush(ignoreBackoff: Bool = false) async -> Int {
        let start = config.now()
        let claimed: Bool = state.withLock { s in
            guard s.enabled, !s.flushing else { return false }
            if let hold = s.holdFlushUntil, start < hold { return false }
            if !ignoreBackoff, let next = s.nextAttemptAt, start < next { return false }
            s.queue.purgeExpired(nowMs: start.unixMs)
            guard !s.queue.isEmpty else { return false }
            s.flushing = true
            return true
        }
        guard claimed else { return 0 }

        var delivered = 0
        while true {
            let siteId = config.siteId
            let next: OutgoingBatch? = state.withLock { s in
                s.enabled ? s.queue.nextBatch(siteId: siteId) : nil
            }
            guard let batch = next else { break }
            let status: Int
            do {
                status = try await config.transport.post(batch.body, to: config.endpoint)
            } catch {
                status = -1
            }
            let outcome = DeliveryOutcome(status: status)
            let failedAt = config.now()
            let jitter = config.jitter()
            state.withLock { s in
                switch outcome {
                case .delivered:
                    s.queue.remove(ids: batch.ids)
                    s.failures = 0
                    s.nextAttemptAt = nil
                case .rejected:
                    s.queue.remove(ids: batch.ids)
                case .retry:
                    s.failures += 1
                    s.nextAttemptAt = failedAt.addingTimeInterval(Backoff.delay(afterFailures: s.failures, jitter: jitter))
                }
            }
            switch outcome {
            case .delivered:
                delivered += batch.ids.count
                sdkLog.debug("FounderData sent \(batch.ids.count, privacy: .public) events")
                continue
            case .rejected:
                sdkLog.error("FounderData server rejected a batch of \(batch.ids.count, privacy: .public) events (HTTP \(status, privacy: .public)), dropped it")
                continue
            case .retry:
                sdkLog.debug("FounderData delivery failed (status \(status, privacy: .public)), will retry")
            }
            break
        }
        state.withLock { $0.flushing = false }
        scheduleSave()
        return delivered
    }

    /// Network came back: forget the backoff and send.
    func networkReturned() async {
        state.withLock { s in
            s.failures = 0
            s.nextAttemptAt = nil
        }
        await flush()
    }

    // MARK: Persistence

    func scheduleSave() {
        let first: Bool = state.withLock { s in
            if s.store == nil || s.saveScheduled { return false }
            s.saveScheduled = true
            return true
        }
        guard first else { return }
        io.asyncAfter(deadline: .now() + config.saveDelay) { [self] in writeSnapshot() }
    }

    /// Writes the state file before returning.
    func saveNow() {
        guard state.withLock({ $0.store != nil }) else { return }
        io.sync { writeSnapshot() }
    }

    private func writeSnapshot() {
        let (store, snapshot): (StateStore?, PersistedState?) = state.withLock { s in
            s.saveScheduled = false
            return (s.store, s.enabled ? s.persisted : nil)
        }
        guard let store else { return }
        if let snapshot {
            store.save(snapshot)
        } else {
            store.delete()
        }
    }

    // MARK: Test access

    var snapshot: State { state.withLock { $0 } }

    // MARK: Helpers

    private func enqueue(_ event: WireEvent, into s: inout State) {
        var event = event
        if event.t == .sessionStart {
            // Every new session starts with the launch's session properties.
            event.sp = s.sessionProperties.isEmpty ? nil : s.sessionProperties
            s.session.state.properties = s.sessionProperties
        }
        var ctx = config.context
        if s.store != nil {
            ctx.consent = true
        } else if let vendor = config.vendorInstallId, s.installId == vendor {
            ctx.id = VendorInstallID.contextValue
        }
        let dropped = s.queue.append(event, vid: s.installId, ctx: ctx)
        if dropped > 0 {
            sdkLog.notice("FounderData queue full, dropped \(dropped, privacy: .public) oldest events")
        }
    }

    static func event(for action: Action, sid: String, at now: Date) -> WireEvent {
        let ts = now.unixMs
        switch action {
        case .screen(let name):
            return WireEvent(t: .screen, sid: sid, ts: ts, n: name)
        case .goal(let name, let props):
            return WireEvent(t: .goal, sid: sid, ts: ts, n: name, p: props.isEmpty ? nil : props)
        case .identify(let userId, let email, let name):
            var p: [String: String] = [:]
            p["user_id"] = userId
            p["email"] = email
            p["name"] = name
            return WireEvent(t: .identify, sid: sid, ts: ts, p: p)
        case .purchase(let jws, _):
            return WireEvent(t: .purchase, sid: sid, ts: ts, jws: jws)
        }
    }
}
