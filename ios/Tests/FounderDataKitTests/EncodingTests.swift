import Foundation
import Testing
@testable import FounderDataKit

@Suite("Payload encoding")
struct EncodingTests {
    /// The example body from docs/APP-API.md section 1 with its placeholders filled in.
    static let contractJSON = """
    {
      "w": "site_1",
      "ctx": {
        "platform": "ios",
        "app_version": "1.4.0",
        "build": "57",
        "os_version": "26.1",
        "device": "iPhone17,1",
        "locale": "en_US",
        "bundle_id": "com.example.shipkit"
      },
      "vid": "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b",
      "events": [
        { "t": "session_start", "sid": "s1", "ts": 1761400000000,
          "src": { "ads_token": "tok", "utm_source": "newsletter", "utm_medium": "email", "utm_campaign": "launch", "ref": "friend" } },
        { "t": "screen",   "sid": "s1", "ts": 1761400001000, "n": "Onboarding/Step2" },
        { "t": "goal",     "sid": "s1", "ts": 1761400002000, "n": "onboarding_complete", "p": { "variant": "b" } },
        { "t": "ping",     "sid": "s1", "ts": 1761400030000, "d": 28000 },
        { "t": "identify", "sid": "s1", "ts": 1761400040000, "p": { "user_id": "u_1", "email": "a@b.c", "name": "A" } },
        { "t": "purchase", "sid": "s1", "ts": 1761400050000, "jws": "eyJhbGciOiJFUzI1NiJ9.e30.sig" }
      ]
    }
    """

    static let contractBatch = WireBatch(
        w: "site_1",
        ctx: .fixture,
        vid: "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b",
        events: [
            WireEvent(t: .sessionStart, sid: "s1", ts: 1_761_400_000_000,
                      src: WireSource(adsToken: "tok", utmSource: "newsletter", utmMedium: "email", utmCampaign: "launch", ref: "friend")),
            WireEvent(t: .screen, sid: "s1", ts: 1_761_400_001_000, n: "Onboarding/Step2"),
            WireEvent(t: .goal, sid: "s1", ts: 1_761_400_002_000, n: "onboarding_complete", p: ["variant": "b"]),
            WireEvent(t: .ping, sid: "s1", ts: 1_761_400_030_000, d: 28_000),
            WireEvent(t: .identify, sid: "s1", ts: 1_761_400_040_000, p: ["user_id": "u_1", "email": "a@b.c", "name": "A"]),
            WireEvent(t: .purchase, sid: "s1", ts: 1_761_400_050_000, jws: "eyJhbGciOiJFUzI1NiJ9.e30.sig"),
        ]
    )

    private func object(_ data: Data) throws -> NSDictionary {
        try #require(JSONSerialization.jsonObject(with: data) as? NSDictionary)
    }

    @Test func matchesContractExample() throws {
        let encoded = try WireCoding.encoder().encode(Self.contractBatch)
        let expected = try object(Data(Self.contractJSON.utf8))
        let actual = try object(encoded)
        #expect(actual == expected)
    }

    @Test func encodesTimestampsAsIntegersAndOmitsNulls() throws {
        let encoded = try WireCoding.encoder().encode(Self.contractBatch)
        let text = try #require(String(data: encoded, encoding: .utf8))
        #expect(text.contains("\"ts\":1761400000000"))
        #expect(text.contains("\"d\":28000"))
        #expect(!text.contains("null"))
        #expect(!text.contains("\\/"))
    }

    @Test func coreBuildsContractEvents() throws {
        let h = Harness(persistent: false)
        defer { h.cleanUp() }
        h.core.attach(linkSource: WireSource(utmSource: "newsletter", utmMedium: "email", utmCampaign: "launch", ref: "friend"))
        h.core.resolveAdsToken("tok")
        h.clock.advance(1)
        h.core.record(.screen("Onboarding/Step2"))
        h.clock.advance(1)
        h.core.record(.goal("onboarding_complete", ["variant": "b"]))
        h.clock.advance(28)
        h.core.tick()
        h.core.appEnteredBackground()
        h.clock.advance(10)
        h.core.record(.identify(userId: "u_1", email: "a@b.c", name: "A"))
        h.clock.advance(10)
        h.core.record(.purchase(jws: "eyJhbGciOiJFUzI1NiJ9.e30.sig", dedupeKey: "1"))

        let batch = try #require(h.core.snapshot.queue.nextBatch(siteId: "site_1"))
        var decoded = try JSONDecoder().decode(WireBatch.self, from: batch.body)
        // No lifecycle in this test, so no ping; splice the contract's ping in to compare the rest.
        decoded.events.insert(Self.contractBatch.events[3], at: 3)
        let actual = try object(WireCoding.encoder().encode(decoded))
        let expected = try object(Data(Self.contractJSON.utf8))
        #expect(actual == expected)
    }

    @Test func consentFlagOnlyWhileTheIdIsKept() throws {
        let kept = Harness()
        defer { kept.cleanUp() }
        kept.core.record(.screen("Home"))
        #expect(kept.core.snapshot.queue.items.allSatisfy { $0.ctx.consent == true })
        let body = try #require(kept.core.snapshot.queue.nextBatch(siteId: "site_1")).body
        #expect(String(decoding: body, as: UTF8.self).contains(#""consent":true"#))

        let memory = Harness(persistent: false)
        memory.core.record(.screen("Home"))
        let plain = try #require(memory.core.snapshot.queue.nextBatch(siteId: "site_1")).body
        #expect(!String(decoding: plain, as: UTF8.self).contains("consent"))
    }

    @Test func identifyOmitsMissingFields() throws {
        let event = Core.event(for: .identify(userId: "u_1", email: nil, name: nil), sid: "s1", at: t0)
        let text = try #require(String(data: WireCoding.encoder().encode(event), encoding: .utf8))
        #expect(text == #"{"p":{"user_id":"u_1"},"sid":"s1","t":"identify","ts":1761400000000}"#)
    }

    @Test func goalWithoutPropsHasNoP() throws {
        let event = Core.event(for: .goal("signup", [:]), sid: "s1", at: t0)
        let text = try #require(String(data: WireCoding.encoder().encode(event), encoding: .utf8))
        #expect(text == #"{"n":"signup","sid":"s1","t":"goal","ts":1761400000000}"#)
    }

    @Test func goalPropsFitTheServerLimit() throws {
        var props: [String: String] = [:]
        for i in 0..<30 { props[String(format: "key%02d", i)] = String(repeating: "v", count: 300) }
        let cleaned = FounderData.cleanedProps(props)
        #expect(cleaned.count == 3)
        #expect(try JSONEncoder().encode(cleaned).count <= 1_000)
        #expect(cleaned["key00"]?.count == 256)
        #expect(FounderData.cleanedProps(["variant": "b", " ": "x"]) == ["variant": "b"])
        #expect(FounderData.cleanedProps((0..<25).reduce(into: [:]) { $0["k\($1)"] = "v" }).count == 20)
    }

    @Test func webVisitorIdUsesRtVidKey() throws {
        let src = WireSource(webVisitorId: "web_visitor_123")
        let text = try #require(String(data: WireCoding.encoder().encode(src), encoding: .utf8))
        #expect(text == #"{"rt_vid":"web_visitor_123"}"#)
    }

    @Test func queueFileWithTheOlderMlVidKeyStillDecodes() throws {
        let old = try JSONDecoder().decode(WireSource.self, from: Data(#"{"ml_vid":"web_visitor_123","ref":"x"}"#.utf8))
        #expect(old == WireSource(ref: "x", webVisitorId: "web_visitor_123"))
        let both = try JSONDecoder().decode(WireSource.self, from: Data(#"{"ml_vid":"old_visitor","rt_vid":"new_visitor"}"#.utf8))
        #expect(both.webVisitorId == "new_visitor")
    }

    @Test func endpointFromHost() {
        #expect(Endpoint.events(host: "https://stats.example.com")?.absoluteString == "https://stats.example.com/api/app/events")
        #expect(Endpoint.events(host: "stats.example.com/")?.absoluteString == "https://stats.example.com/api/app/events")
        #expect(Endpoint.events(host: "http://localhost:8787")?.absoluteString == "http://localhost:8787/api/app/events")
        #expect(Endpoint.events(host: "  ") == nil)
    }

    @Test func installIdNormalisesToLowercaseUUID() {
        #expect(InstallIDStore.normalized("6F1C2B9E-0D4A-4E57-9A0B-3C2D1E0F9A8B") == "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b")
        #expect(InstallIDStore.normalized("not-a-uuid") == nil)
    }
}
