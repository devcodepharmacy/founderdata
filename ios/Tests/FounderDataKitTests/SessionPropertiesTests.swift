import Foundation
import Testing
@testable import FounderDataKit

@Suite("Session properties, experiments and onboarding")
struct SessionPropertiesTests {
    @Test func keysAreLowercaseSnakeCase() {
        #expect(FounderData.propertyKey("User State") == "user_state")
        #expect(FounderData.propertyKey("  _Paywall-Copy!_ ") == "paywall_copy")
        #expect(FounderData.propertyKey("---") == nil)
        #expect(FounderData.propertyKey(String(repeating: "a", count: 60))?.count == 40)
    }

    @Test func mergeCapsAtTenAndEmptyValueRemoves() {
        var props: [String: String] = [:]
        for i in 0..<12 { props = FounderData.mergedSessionProperties(props, [String(format: "k%02d", i): "v"]) }
        #expect(props.count == FounderData.maxSessionProperties)
        #expect(props["k10"] == nil)
        props = FounderData.mergedSessionProperties(props, ["k00": "", "k10": "x"])
        #expect(props["k00"] == nil)
        props = FounderData.mergedSessionProperties(props, ["k10": "x"])
        #expect(props["k10"] == "x")
        props = FounderData.mergedSessionProperties(props, ["k01": String(repeating: "v", count: 150)])
        #expect(props["k01"]?.count == 100)
        // An existing key can always be changed, even at the cap.
        props = FounderData.mergedSessionProperties(props, ["k02": "changed"])
        #expect(props["k02"] == "changed")
    }

    @Test func onboardingStepGoal() throws {
        let goal = try #require(FounderData.onboardingGoal(2, "Notifications"))
        guard case .goal(let name, let props) = goal else { Issue.record("not a goal"); return }
        #expect(name == "onboarding_notifications")
        #expect(props == ["step": "notifications", "index": "2"])
        #expect(FounderData.onboardingGoal(1, "  ") == nil)
    }

    @Test func propertiesSetBeforeTheFirstEventRideOnSessionStart() {
        let h = Harness(persistent: false)
        h.core.setSessionProperties(["user_state": "new", "exp_paywall": "b"])
        h.core.record(.screen("Home"))
        #expect(h.queued.map(\.t) == [.sessionStart, .screen])
        #expect(h.queued.first?.sp == ["user_state": "new", "exp_paywall": "b"])
    }

    @Test func changeWhileSessionStartIsQueuedRewritesItWithoutAnExtraEvent() {
        let h = Harness(persistent: false)
        h.core.record(.screen("Home"))
        h.core.setSessionProperties(["user_state": "returning"])
        #expect(h.queued.map(\.t) == [.sessionStart, .screen])
        #expect(h.queued.first?.sp == ["user_state": "returning"])
    }

    @Test func changeAfterSessionStartWasSentSendsOneEventWithTheFullSet() async throws {
        let h = Harness(persistent: false)
        h.core.setSessionProperties(["user_state": "new"])
        h.core.record(.screen("Home"))
        await h.core.flush(ignoreBackoff: true)
        #expect(h.queued.isEmpty)
        h.clock.advance(5)
        h.core.setSessionProperties(["user_state": "new", "onboarding_variant": "b"])
        let sid = try #require(h.core.snapshot.session.sessionId)
        #expect(h.queued == [WireEvent(t: .sessionProps, sid: sid, ts: h.clock.now.unixMs, p: ["user_state": "new", "onboarding_variant": "b"])])
        // The same set again sends nothing.
        h.core.setSessionProperties(["user_state": "new", "onboarding_variant": "b"])
        #expect(h.queued.count == 1)
    }

    @Test func aLaterSessionStartsWithTheProperties() {
        let h = Harness(persistent: false)
        h.core.setSessionProperties(["build_channel": "testflight"])
        h.core.record(.screen("Home"))
        h.core.appEnteredBackground()
        h.clock.advance(31 * 60)
        h.core.record(.screen("Home"))
        let starts = h.queued.filter { $0.t == .sessionStart }
        #expect(starts.count == 2)
        #expect(starts.allSatisfy { $0.sp == ["build_channel": "testflight"] })
    }

    @Test func noSessionYetMeansNoEvent() {
        let h = Harness(persistent: false)
        h.core.setSessionProperties(["user_state": "new"])
        #expect(h.queued.isEmpty)
    }

    @Test func memoryModeStillWritesNothing() {
        let h = Harness(persistent: false)
        defer { h.cleanUp() }
        h.core.record(.screen("Home"))
        h.core.setSessionProperties(["user_state": "new"])
        h.core.saveNow()
        #expect(!FileManager.default.fileExists(atPath: h.directory.path))
    }

    @Test func encodesSessionPropsOnTheWire() throws {
        let start = WireEvent(t: .sessionStart, sid: "s1", ts: t0.unixMs, sp: ["user_state": "new"])
        let text = try #require(String(data: WireCoding.encoder().encode(start), encoding: .utf8))
        #expect(text == #"{"sid":"s1","sp":{"user_state":"new"},"t":"session_start","ts":1761400000000}"#)
        let change = WireEvent(t: .sessionProps, sid: "s1", ts: t0.unixMs, p: ["exp_paywall": "b"])
        let text2 = try #require(String(data: WireCoding.encoder().encode(change), encoding: .utf8))
        #expect(text2 == #"{"p":{"exp_paywall":"b"},"sid":"s1","t":"session_props","ts":1761400000000}"#)
    }

    @Test func persistedSessionKeepsItsPropertiesSoARelaunchSendsNothingNew() async throws {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.setSessionProperties(["user_state": "returning"])
        h.core.record(.screen("Home"))
        await h.core.flush(ignoreBackoff: true)
        h.core.appEnteredBackground()
        let relaunched = Harness.makeCore(directory: h.directory, clock: h.clock, transport: h.transport, ids: h.ids)
        relaunched.setSessionProperties(["user_state": "returning"])
        #expect(relaunched.snapshot.queue.items.isEmpty)
        relaunched.setSessionProperties(["user_state": "new"])
        #expect(relaunched.snapshot.queue.items.map(\.event.t) == [.sessionProps])
    }
}
