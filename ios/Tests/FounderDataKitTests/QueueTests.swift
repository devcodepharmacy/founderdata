import Foundation
import Testing
@testable import FounderDataKit

@Suite("Queue")
struct QueueTests {
    private let vid = "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b"

    private func screen(_ i: Int, ts: Int64 = t0.unixMs) -> WireEvent {
        WireEvent(t: .screen, sid: "s1", ts: ts, n: "Screen\(i)")
    }

    @Test func capKeepsNewestTwoThousand() {
        var q = EventQueue()
        var dropped = 0
        for i in 0..<2_050 { dropped += q.append(screen(i), vid: vid, ctx: .fixture) }
        #expect(q.count == 2_000)
        #expect(dropped == 50)
        #expect(q.items.first?.event.n == "Screen50")
        #expect(q.items.last?.event.n == "Screen2049")
    }

    @Test func dropsEventsOlderThanSeventyTwoHours() {
        var q = EventQueue()
        let now = t0.unixMs
        q.append(screen(0, ts: now - EventQueue.maxAgeMs - 1), vid: vid, ctx: .fixture)
        q.append(screen(1, ts: now - EventQueue.maxAgeMs), vid: vid, ctx: .fixture)
        q.append(screen(2, ts: now), vid: vid, ctx: .fixture)
        #expect(q.purgeExpired(nowMs: now) == 1)
        #expect(q.items.map(\.event.n) == ["Screen1", "Screen2"])
    }

    @Test func batchHoldsAtMostFifty() throws {
        var q = EventQueue()
        for i in 0..<120 { q.append(screen(i), vid: vid, ctx: .fixture) }
        let batch = try #require(q.nextBatch(siteId: "site_1"))
        #expect(batch.ids.count == 50)
        let decoded = try JSONDecoder().decode(WireBatch.self, from: batch.body)
        #expect(decoded.events.count == 50)
        #expect(decoded.events.first?.n == "Screen0")
    }

    @Test func batchStaysUnderBodyLimit() throws {
        var q = EventQueue()
        let jws = String(repeating: "a", count: 5_000)
        for _ in 0..<30 {
            q.append(WireEvent(t: .purchase, sid: "s1", ts: t0.unixMs, jws: jws), vid: vid, ctx: .fixture)
        }
        let batch = try #require(q.nextBatch(siteId: "site_1"))
        #expect(batch.body.count <= EventQueue.maxBodyBytes)
        #expect(batch.ids.count == 12)
        #expect(batch.body.count < 64 * 1024)
    }

    @Test func oversizedSingleEventStillLeavesAlone() throws {
        var q = EventQueue()
        q.append(WireEvent(t: .purchase, sid: "s1", ts: t0.unixMs, jws: String(repeating: "b", count: 70_000)), vid: vid, ctx: .fixture)
        q.append(screen(1), vid: vid, ctx: .fixture)
        let batch = try #require(q.nextBatch(siteId: "site_1"))
        #expect(batch.ids == [1])
    }

    @Test func batchDoesNotMixContexts() throws {
        var q = EventQueue()
        var newer = WireContext.fixture
        newer.appVersion = "1.5.0"
        q.append(screen(0), vid: vid, ctx: .fixture)
        q.append(screen(1), vid: vid, ctx: .fixture)
        q.append(screen(2), vid: vid, ctx: newer)
        let first = try #require(q.nextBatch(siteId: "site_1"))
        #expect(first.ids == [1, 2])
        q.remove(ids: first.ids)
        let second = try #require(q.nextBatch(siteId: "site_1"))
        let decoded = try JSONDecoder().decode(WireBatch.self, from: second.body)
        #expect(decoded.ctx.appVersion == "1.5.0")
    }

    @Test func queueAndSessionSurviveRelaunch() throws {
        let first = Harness()
        defer { first.cleanUp() }
        first.core.appBecameActive()
        first.core.record(.screen("Home"))
        first.core.record(.goal("onboarding_complete", ["variant": "b"]))
        first.core.saveNow()
        #expect(FileManager.default.fileExists(atPath: first.stateFile.path))

        let second = Harness.makeCore(directory: first.directory, clock: first.clock, transport: first.transport, ids: first.ids)
        let restored = second.snapshot
        #expect(restored.queue.items.map(\.event.t) == [.sessionStart, .screen, .goal])
        #expect(restored.queue.items.map(\.id) == [1, 2, 3])
        #expect(restored.session.sessionId == "s1")
        #expect(restored.session.state.activeSince == nil)

        second.record(.screen("Settings"))
        #expect(second.snapshot.queue.items.last?.id == 4)
        #expect(second.snapshot.queue.items.last?.event.sid == "s1")
    }

    @Test func relaunchDropsExpiredEvents() {
        let first = Harness()
        defer { first.cleanUp() }
        first.core.record(.screen("Old"))
        first.core.saveNow()
        first.clock.advance(73 * 3600)
        let second = Harness.makeCore(directory: first.directory, clock: first.clock, transport: first.transport, ids: first.ids)
        #expect(second.snapshot.queue.isEmpty)
    }

    @Test func flushSendsAllAndEmptiesQueue() async throws {
        let h = Harness()
        defer { h.cleanUp() }
        for i in 0..<119 { h.core.record(.screen("S\(i)")) }
        let sent = await h.core.flush()
        #expect(sent == 120)
        #expect(h.transport.batches.map(\.events.count) == [50, 50, 20])
        #expect(h.core.snapshot.queue.isEmpty)
    }

    @Test func failureKeepsEventsAndBacksOff() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.transport.script([503])
        h.core.record(.screen("Home"))
        #expect(await h.core.flush() == 0)
        #expect(h.core.snapshot.queue.count == 2)
        #expect(h.core.snapshot.nextAttemptAt == t0.addingTimeInterval(5))

        h.clock.advance(2)
        #expect(await h.core.flush() == 0)
        #expect(h.transport.bodies.count == 1)

        h.transport.script([-1])
        h.clock.advance(4)
        #expect(await h.core.flush() == 0)
        #expect(h.core.snapshot.failures == 2)
        #expect(h.core.snapshot.nextAttemptAt == t0.addingTimeInterval(6 + 10))

        await h.core.networkReturned()
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(h.core.snapshot.failures == 0)
    }

    @Test func backoffDoublesAndCaps() {
        #expect(Backoff.delay(afterFailures: 1) == 5)
        #expect(Backoff.delay(afterFailures: 2) == 10)
        #expect(Backoff.delay(afterFailures: 5) == 80)
        #expect(Backoff.delay(afterFailures: 12) == 900)
        #expect(Backoff.delay(afterFailures: 400) == 900)
    }

    @Test func badPayloadIsDropped() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.transport.script([400])
        h.core.record(.screen("Home"))
        #expect(await h.core.flush() == 0)
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(h.core.snapshot.failures == 0)
    }

    @Test func statusCodesMapToOutcomes() {
        #expect(DeliveryOutcome(status: 202) == .delivered)
        #expect(DeliveryOutcome(status: 400) == .rejected)
        #expect(DeliveryOutcome(status: 403) == .rejected)
        #expect(DeliveryOutcome(status: 413) == .rejected)
        #expect(DeliveryOutcome(status: 404) == .retry)
        #expect(DeliveryOutcome(status: 429) == .retry)
        #expect(DeliveryOutcome(status: 500) == .retry)
        #expect(DeliveryOutcome(status: -1) == .retry)
    }

    @Test func wrongBundleIsDroppedNotRetried() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.transport.script([403])
        h.core.record(.screen("Home"))
        #expect(await h.core.flush() == 0)
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(h.core.snapshot.nextAttemptAt == nil)
        #expect(h.transport.bodies.count == 1)
    }

    @Test func partialRejectionIsNotResent() async {
        // The server answers 202 {ok:true, rejected:n} and has already skipped the bad events.
        let h = Harness()
        defer { h.cleanUp() }
        h.transport.script([202])
        h.core.record(.goal("", [:]))
        h.core.record(.screen("Home"))
        #expect(await h.core.flush() == 3)
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(await h.core.flush() == 0)
        #expect(h.transport.bodies.count == 1)
    }

    @Test func optOutClearsQueueAndFile() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        h.core.saveNow()
        #expect(FileManager.default.fileExists(atPath: h.stateFile.path))

        h.core.setEnabled(false)
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(!FileManager.default.fileExists(atPath: h.stateFile.path))
        h.core.record(.screen("Ignored"))
        #expect(h.core.snapshot.queue.isEmpty)
        #expect(await h.core.flush() == 0)
        #expect(h.transport.bodies.isEmpty)

        h.core.setEnabled(true)
        h.core.record(.screen("Back"))
        #expect(h.queued.map(\.t) == [.sessionStart, .screen])
    }

    @Test func purchaseIsReportedOncePerTransaction() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.record(.purchase(jws: "eyJ.a.b", dedupeKey: "2000000123"))
        h.core.record(.purchase(jws: "eyJ.a.b", dedupeKey: "2000000123"))
        h.core.record(.purchase(jws: "eyJ.c.d", dedupeKey: "2000000124"))
        #expect(h.queued.map(\.t) == [.sessionStart, .purchase, .purchase])
        #expect(h.queued.compactMap(\.jws) == ["eyJ.a.b", "eyJ.c.d"])
    }

    @Test func adsTokenHoldsFirstFlushAndJoinsFirstSession() async {
        let h = Harness()
        defer { h.cleanUp() }
        #expect(h.core.needsAdsToken)
        h.core.holdForAdsToken()
        h.core.appBecameActive()
        h.core.record(.screen("Home"))
        #expect(await h.core.flush() == 0)
        #expect(h.transport.bodies.isEmpty)

        h.core.resolveAdsToken("ads-token-123")
        #expect(!h.core.needsAdsToken)
        #expect(await h.core.flush() == 2)
        let start = h.transport.batches.first?.events.first
        #expect(start?.t == .sessionStart)
        #expect(start?.src?.adsToken == "ads-token-123")
    }

    @Test func adsTokenWaitExpires() async {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.holdForAdsToken()
        h.core.record(.screen("Home"))
        h.clock.advance(11)
        #expect(await h.core.flush() == 2)
    }
}
