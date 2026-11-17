import Foundation
import Testing
@testable import FounderDataKit

@Suite("Sessions")
struct SessionTests {
    private func tracker() -> SessionTracker {
        let ids = Counter()
        return SessionTracker(makeId: { ids.next() })
    }

    @Test func firstEventStartsSession() {
        var s = tracker()
        let (sid, start) = s.ensureSession(at: t0, source: nil)
        #expect(sid == "s1")
        #expect(start == WireEvent(t: .sessionStart, sid: "s1", ts: t0.unixMs))
        let (again, none) = s.ensureSession(at: t0.addingTimeInterval(5), source: nil)
        #expect(again == "s1")
        #expect(none == nil)
    }

    @Test func foregroundStartsSessionAndBackgroundPingsEngagedTime() {
        var s = tracker()
        let start = s.becameActive(at: t0, source: nil)
        #expect(start?.t == .sessionStart)
        let pings = s.enteredBackground(at: t0.addingTimeInterval(28))
        #expect(pings == [WireEvent(t: .ping, sid: "s1", ts: t0.addingTimeInterval(28).unixMs, d: 28_000)])
    }

    @Test func interruptionDoesNotCountAsEngaged() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        s.resignedActive(at: t0.addingTimeInterval(10))
        _ = s.becameActive(at: t0.addingTimeInterval(70), source: nil)
        let pings = s.enteredBackground(at: t0.addingTimeInterval(75))
        #expect(pings.map(\.d) == [15_000])
    }

    @Test func backgroundUnderThirtyMinutesKeepsSession() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        _ = s.enteredBackground(at: t0.addingTimeInterval(60))
        let start = s.becameActive(at: t0.addingTimeInterval(60 + 29 * 60), source: nil)
        #expect(start == nil)
        #expect(s.sessionId == "s1")
    }

    @Test func backgroundThirtyMinutesStartsNewSession() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        _ = s.enteredBackground(at: t0.addingTimeInterval(60))
        let start = s.becameActive(at: t0.addingTimeInterval(60 + 30 * 60), source: nil)
        #expect(start?.t == .sessionStart)
        #expect(start?.sid == "s2")
        #expect(s.sessionId == "s2")
    }

    @Test func eventInBackgroundAfterTimeoutStartsNewSession() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        _ = s.enteredBackground(at: t0.addingTimeInterval(10))
        let (sid, start) = s.ensureSession(at: t0.addingTimeInterval(10 + 31 * 60), source: nil)
        #expect(sid == "s2")
        #expect(start != nil)
    }

    @Test func idleWithoutLifecycleRollsOver() {
        var s = tracker()
        _ = s.ensureSession(at: t0, source: nil)
        _ = s.ensureSession(at: t0.addingTimeInterval(20 * 60), source: nil)
        #expect(s.sessionId == "s1")
        _ = s.ensureSession(at: t0.addingTimeInterval(20 * 60 + 30 * 60), source: nil)
        #expect(s.sessionId == "s2")
    }

    @Test func activeAppNeverTimesOut() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        let (sid, start) = s.ensureSession(at: t0.addingTimeInterval(2 * 3600), source: nil)
        #expect(sid == "s1")
        #expect(start == nil)
    }

    @Test func tickPingsEveryFiveMinutesWhileActive() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        #expect(s.tick(at: t0.addingTimeInterval(270)).isEmpty)
        #expect(s.tick(at: t0.addingTimeInterval(300)).map(\.d) == [300_000])
        let rest = s.enteredBackground(at: t0.addingTimeInterval(330))
        #expect(rest.map(\.d) == [30_000])
    }

    @Test func longStretchIsSplitIntoTenMinutePings() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        let pings = s.enteredBackground(at: t0.addingTimeInterval(25 * 60))
        #expect(pings.map(\.d) == [600_000, 600_000, 300_000])
    }

    @Test func sourceGoesIntoSessionStart() {
        var s = tracker()
        let src = WireSource(utmSource: "x", ref: "y")
        let start = s.becameActive(at: t0, source: src)
        #expect(start?.src == src)
        let empty = WireSource()
        var other = tracker()
        #expect(other.becameActive(at: t0, source: empty)?.src == nil)
    }

    @Test func coldLaunchContinuesRecentSession() {
        var s = tracker()
        _ = s.becameActive(at: t0, source: nil)
        _ = s.enteredBackground(at: t0.addingTimeInterval(60))
        var relaunched = SessionTracker(state: s.state, makeId: { "new" })
        relaunched.relaunched()
        #expect(relaunched.becameActive(at: t0.addingTimeInterval(10 * 60), source: nil) == nil)
        #expect(relaunched.sessionId == "s1")

        var late = SessionTracker(state: s.state, makeId: { "new" })
        late.relaunched()
        #expect(late.becameActive(at: t0.addingTimeInterval(45 * 60), source: nil)?.sid == "new")
    }

    @Test func coreRollsSessionAcrossLongBackground() {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.appBecameActive()
        FounderData_screen(h, "Home")
        h.clock.advance(40)
        h.core.appResignedActive()
        h.core.appEnteredBackground()
        h.clock.advance(31 * 60)
        h.core.appBecameActive()
        FounderData_screen(h, "Home")
        let types = h.queued.map { "\($0.t.rawValue):\($0.sid)" }
        #expect(types == [
            "session_start:s1", "screen:s1", "ping:s1",
            "session_start:s2", "screen:s2",
        ])
        #expect(h.queued[2].d == 40_000)
    }
}

/// Records a screen on a harness core (the public API needs `configure`).
func FounderData_screen(_ h: Harness, _ name: String) {
    h.core.record(.screen(name))
}
