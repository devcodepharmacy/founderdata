import Foundation

/// Persisted part of the session clock.
struct SessionState: Codable, Equatable, Sendable {
    var sessionId: String?
    var startedAt: Date?
    var lastActivityAt: Date?
    /// Set while the app is in the background.
    var backgroundedAt: Date?
    /// Set while the app is active (foreground and not interrupted).
    var activeSince: Date?
    /// Engaged time not yet reported in a ping.
    var engagedMs: Int64 = 0
    /// Session properties this session already carries (on its `session_start` or a `session_props` event).
    var properties: [String: String]?
}

/// Session rules, kept free of UIKit and I/O so tests can drive them with a fake clock.
///
/// - A session starts on the first event or when the app becomes active.
/// - It ends after 30 minutes in the background (or 30 minutes idle when no
///   lifecycle callbacks arrive); the next event or foreground starts a new one.
/// - `ping` carries engaged time as a delta. The server adds it to the session
///   duration and caps one ping at 10 minutes, so the tracker reports every
///   5 minutes while active and splits anything longer.
struct SessionTracker: Sendable {
    static let timeout: TimeInterval = 30 * 60
    static let pingInterval: Int64 = 5 * 60 * 1000
    static let maxPingMs: Int64 = 10 * 60 * 1000

    var state: SessionState
    var makeId: @Sendable () -> String

    init(
        state: SessionState = SessionState(),
        makeId: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.state = state
        self.makeId = makeId
    }

    var sessionId: String? { state.sessionId }

    func isExpired(at now: Date) -> Bool {
        guard state.sessionId != nil else { return true }
        if state.activeSince != nil { return false }
        guard let idleSince = state.backgroundedAt ?? state.lastActivityAt ?? state.startedAt else { return true }
        return now.timeIntervalSince(idleSince) >= Self.timeout
    }

    /// Returns the session id for an event at `now`, and a `session_start` if a new session began.
    mutating func ensureSession(at now: Date, source: WireSource?) -> (sid: String, start: WireEvent?) {
        if !isExpired(at: now), let sid = state.sessionId {
            state.lastActivityAt = now
            return (sid, nil)
        }
        let (sid, start) = startSession(at: now, source: source)
        return (sid, start)
    }

    /// Starts a new session unconditionally. Call `closeForRestart` first to report open engaged time.
    mutating func startSession(at now: Date, source: WireSource?) -> (sid: String, start: WireEvent) {
        let sid = makeId()
        let wasActive = state.activeSince != nil
        state = SessionState(
            sessionId: sid,
            startedAt: now,
            lastActivityAt: now,
            backgroundedAt: nil,
            activeSince: wasActive ? now : nil,
            engagedMs: 0
        )
        let src = (source?.isEmpty ?? true) ? nil : source
        return (sid, WireEvent(t: .sessionStart, sid: sid, ts: now.unixMs, src: src))
    }

    /// App became active. Starts a session when none is running or the old one timed out.
    mutating func becameActive(at now: Date, source: WireSource?) -> WireEvent? {
        var start: WireEvent?
        if isExpired(at: now) {
            start = startSession(at: now, source: source).start
        }
        state.backgroundedAt = nil
        if state.activeSince == nil { state.activeSince = now }
        state.lastActivityAt = now
        return start
    }

    mutating func resignedActive(at now: Date) {
        guard let since = state.activeSince else { return }
        state.engagedMs += Self.ms(from: since, to: now)
        state.activeSince = nil
        state.lastActivityAt = now
    }

    /// App went to the background. Returns the pings for engaged time since the last ping.
    mutating func enteredBackground(at now: Date) -> [WireEvent] {
        resignedActive(at: now)
        let total = state.engagedMs
        state.engagedMs = 0
        state.backgroundedAt = now
        state.lastActivityAt = now
        return pings(totalMs: total, at: now)
    }

    /// Timer tick while active. Reports engaged time once it reaches 5 minutes.
    mutating func tick(at now: Date) -> [WireEvent] {
        guard state.sessionId != nil, let since = state.activeSince else { return [] }
        let total = state.engagedMs + Self.ms(from: since, to: now)
        guard total >= Self.pingInterval else { return [] }
        state.engagedMs = 0
        state.activeSince = now
        state.lastActivityAt = now
        return pings(totalMs: total, at: now)
    }

    /// Reports engaged time of the current session before a new session replaces it.
    mutating func closeForRestart(at now: Date) -> [WireEvent] {
        var total = state.engagedMs
        if let since = state.activeSince {
            total += Self.ms(from: since, to: now)
            state.activeSince = now
        }
        state.engagedMs = 0
        return pings(totalMs: total, at: now)
    }

    /// Ends the session without a ping; call `closeForRestart` first. The next event starts a new session,
    /// and an app that is still active stays active in it.
    mutating func end() {
        state = SessionState(activeSince: state.activeSince)
    }

    /// After a cold launch the process was gone, so there is no active stretch to continue.
    mutating func relaunched() {
        state.activeSince = nil
        state.engagedMs = 0
    }

    private func pings(totalMs: Int64, at now: Date) -> [WireEvent] {
        guard let sid = state.sessionId, totalMs > 0 else { return [] }
        var remaining = totalMs
        var out: [WireEvent] = []
        while remaining > 0 {
            let chunk = min(remaining, Self.maxPingMs)
            out.append(WireEvent(t: .ping, sid: sid, ts: now.unixMs, d: chunk))
            remaining -= chunk
        }
        return out
    }

    static func ms(from start: Date, to end: Date) -> Int64 {
        max(0, Int64((end.timeIntervalSince(start) * 1000).rounded()))
    }
}
