import Foundation
import Testing
@testable import FounderDataKit

@Suite("Link attribution")
struct URLParsingTests {
    private func source(_ string: String) -> WireSource? {
        LinkAttribution.source(from: URL(string: string)!)
    }

    @Test func readsUtmRefAndWebVisitor() {
        let src = source("https://example.com/open?utm_source=tiktok&utm_medium=social&utm_campaign=oct&utm_term=launch&utm_content=v2&ref=friend&rt_vid=abc123def456")
        #expect(src == WireSource(
            utmSource: "tiktok", utmMedium: "social", utmCampaign: "oct",
            utmTerm: "launch", utmContent: "v2", ref: "friend", webVisitorId: "abc123def456"
        ))
    }

    @Test func customSchemeWorks() {
        #expect(source("shipkit://item/42?utm_source=newsletter")?.utmSource == "newsletter")
    }

    @Test func linkWithoutParametersHasNoSource() {
        #expect(source("https://example.com/item/42") == nil)
        #expect(source("https://example.com/item/42?id=7&lang=en") == nil)
        #expect(source("https://example.com/?utm_source=") == nil)
    }

    @Test func namesAreCaseInsensitiveAndFirstValueWins() {
        let src = source("https://example.com/?UTM_Source=a&utm_source=b&Ref=x")
        #expect(src?.utmSource == "a")
        #expect(src?.ref == "x")
    }

    @Test func percentEncodingIsDecoded() {
        #expect(source("https://example.com/?utm_campaign=black%20friday")?.utmCampaign == "black friday")
    }

    @Test func invalidWebVisitorIdIsIgnored() {
        #expect(source("https://example.com/?rt_vid=short") == nil)
        #expect(source("https://example.com/?rt_vid=has%20space%20inside") == nil)
        #expect(source("https://example.com/?rt_vid=\(String(repeating: "a", count: 65))") == nil)
        #expect(source("https://example.com/?rt_vid=12345678")?.webVisitorId == "12345678")
        #expect(source("https://example.com/?rt_vid=web_visitor-1&ref=x")?.webVisitorId == "web_visitor-1")
    }

    @Test func readsTheOlderMlVidParameter() {
        #expect(source("https://example.com/?ml_vid=web_visitor-2")?.webVisitorId == "web_visitor-2")
        #expect(source("https://example.com/?ml_vid=old_visitor_1&rt_vid=new_visitor_1")?.webVisitorId == "new_visitor_1")
    }

    @Test func longValuesAreClipped() {
        let long = String(repeating: "x", count: 500)
        #expect(source("https://example.com/?utm_campaign=\(long)")?.utmCampaign?.count == 200)
    }

    @Test func readsAdClickIds() {
        let google = source("https://example.com/open?gclid=Cj0KCQiA-abc_123")
        #expect(google == WireSource(clickNetwork: "google_ads", clickId: "Cj0KCQiA-abc_123"))
        #expect(source("https://example.com/?wbraid=ABCDEFGH12")?.clickNetwork == "google_ads")
        #expect(source("https://example.com/?msclkid=0f1e2d3c4b5a")?.clickNetwork == "microsoft_ads")
        #expect(source("https://example.com/?ttclid=E.C.P.abc123+/=")?.clickId == "E.C.P.abc123+/=")
        #expect(source("https://example.com/?twclid=2-abcdefgh")?.clickNetwork == "x_ads")
        #expect(source("https://example.com/?li_fat_id=7c1b9e7a-1111")?.clickNetwork == "linkedin_ads")
        #expect(source("https://example.com/?rdt_cid=1234567890123")?.clickNetwork == "reddit_ads")
        #expect(source("https://example.com/?ScCid=abcdef123456")?.clickNetwork == "snapchat_ads")
        #expect(source("https://example.com/?epik=dj0yJnU9abc")?.clickNetwork == "pinterest_ads")
        let tagged = source("https://example.com/?utm_source=google&utm_medium=cpc&gclid=abcdefgh12")
        #expect(tagged?.utmSource == "google")
        #expect(tagged?.clickId == "abcdefgh12")
    }

    @Test func clickIdOrderMatchesTheServer() {
        // Network order first (Google before Microsoft), then parameter order (gclid before gbraid).
        #expect(source("https://example.com/?msclkid=bbbbbbbb11&gclid=aaaaaaaa11")?.clickNetwork == "google_ads")
        #expect(source("https://example.com/?gbraid=bbbbbbbb22&gclid=aaaaaaaa22")?.clickId == "aaaaaaaa22")
    }

    @Test func invalidClickIdsAreIgnored() {
        #expect(source("https://example.com/?gclid=%7Bgclid%7D") == nil)
        #expect(source("https://example.com/?gclid=short") == nil)
        #expect(source("https://example.com/?gclid=\(String(repeating: "a", count: 501))") == nil)
        #expect(source("https://example.com/?gclid=\(String(repeating: "a", count: 500))")?.clickId?.count == 500)
        // An unfilled macro does not hide a valid id from another network.
        #expect(source("https://example.com/?gclid=%7Bgclid%7D&msclkid=abcdefgh12")?.clickNetwork == "microsoft_ads")
    }

    @Test func aLaterLinkReplacesTheClickAsAPair() {
        let first = WireSource(utmSource: "x", clickNetwork: "google_ads", clickId: "aaaaaaaa11")
        #expect(first.merging(WireSource(utmSource: "y")).clickId == "aaaaaaaa11")
        let merged = first.merging(WireSource(clickNetwork: "tiktok_ads", clickId: "bbbbbbbb22"))
        #expect(merged.clickNetwork == "tiktok_ads")
        #expect(merged.clickId == "bbbbbbbb22")
    }

    @Test func clickIdsEncodeForTheServer() throws {
        let data = try JSONEncoder().encode(WireSource(clickNetwork: "google_ads", clickId: "abcdefgh12"))
        let json = try #require(String(data: data, encoding: .utf8))
        #expect(json.contains("\"click_network\":\"google_ads\""))
        #expect(json.contains("\"click_id\":\"abcdefgh12\""))
        #expect(try JSONDecoder().decode(WireSource.self, from: data).clickId == "abcdefgh12")
    }

    @Test func coldLaunchLinkFillsTheNewSession() {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.appBecameActive()
        h.core.record(.screen("Home"))
        h.clock.advance(2)
        h.core.attach(linkSource: WireSource(utmSource: "tiktok"))
        #expect(h.queued.map(\.t) == [.sessionStart, .screen])
        #expect(h.queued.first?.src?.utmSource == "tiktok")
    }

    @Test func laterLinkStartsANewSession() {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.appBecameActive()
        h.clock.advance(120)
        h.core.attach(linkSource: WireSource(ref: "newsletter"))
        let events = h.queued
        #expect(events.map(\.t) == [.sessionStart, .ping, .sessionStart])
        #expect(events[1].sid == "s1")
        #expect(events[1].d == 120_000)
        #expect(events[2].sid == "s2")
        #expect(events[2].src?.ref == "newsletter")
    }

    @Test func linkBeforeAnySessionStartsOne() {
        let h = Harness()
        defer { h.cleanUp() }
        h.core.attach(linkSource: WireSource(webVisitorId: "web_visitor_1"))
        #expect(h.queued.map(\.t) == [.sessionStart])
        #expect(h.queued.first?.src?.webVisitorId == "web_visitor_1")
    }
}
