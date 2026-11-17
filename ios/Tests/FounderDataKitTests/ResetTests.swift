import Foundation
import Testing
@testable import FounderDataKit

/// `FounderData.reset()` on sign-out: a new install id and a new session, so the next user is not linked
/// to the one before.
@Suite("Reset on sign-out")
struct ResetTests {
    private let oldId = "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"
    private let newId = "11111111-2222-4333-8444-555555555555"

    @Test func resetStartsANewSessionUnderTheNewId() throws {
        let h = Harness(persistent: false)
        h.core.appBecameActive()
        h.core.record(.screen("Account"))
        let oldSid = try #require(h.core.snapshot.session.sessionId)
        h.clock.advance(20)
        h.core.resetIdentity(installId: newId)
        #expect(h.core.installId == newId)
        #expect(h.core.snapshot.session.sessionId == nil)

        h.core.record(.screen("SignIn"))
        let items = h.core.snapshot.queue.items
        let ping = try #require(items.first { $0.event.t == .ping })
        #expect(ping.vid == oldId)
        #expect(ping.event.sid == oldSid)
        #expect(ping.event.d == 20_000)
        #expect(items.filter { $0.event.t == .sessionStart }.map(\.vid) == [oldId, newId])
        #expect(items.last?.vid == newId)
        #expect(items.last?.event.sid != oldSid)
    }

    @Test func engagedTimeKeepsCountingAfterReset() throws {
        let h = Harness(persistent: false)
        h.core.appBecameActive()
        h.clock.advance(5)
        h.core.resetIdentity(installId: newId)
        h.core.record(.screen("SignIn"))
        let newSid = try #require(h.core.snapshot.session.sessionId)
        h.clock.advance(30)
        h.core.appEnteredBackground()
        let pings = h.core.snapshot.queue.items.filter { $0.event.t == .ping && $0.event.sid == newSid }
        #expect(pings.map(\.event.d) == [30_000])
        #expect(pings.map(\.vid) == [newId])
    }

    @Test func resetWithConsentKeepsSavingTheQueue() throws {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.record(.screen("Account"))
        h.core.resetIdentity(installId: newId)
        h.core.record(.screen("SignIn"))
        h.core.saveNow()
        #expect(h.core.isPersistent)
        let stored = try #require(StateStore(fileURL: h.stateFile).load())
        #expect(stored.queue.items.map(\.vid) == [oldId, oldId, newId, newId])
    }

    @Test func resetWhileOptedOutOnlyChangesTheId() {
        let h = Harness(enabled: false, persistent: false)
        h.core.resetIdentity(installId: newId)
        #expect(h.core.installId == newId)
        #expect(h.core.snapshot.queue.isEmpty)
    }
}
