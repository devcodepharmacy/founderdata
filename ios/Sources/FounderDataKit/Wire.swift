import Foundation

// Wire format of POST /api/app/events. Field names follow docs/APP-API.md section 1.
// Optional fields are omitted when nil (synthesized Codable uses encodeIfPresent).

/// Device and app context sent once per batch as `ctx`.
struct WireContext: Codable, Equatable, Hashable, Sendable {
    var platform: String = "ios"
    var appVersion: String
    var build: String
    var osVersion: String
    var device: String
    var locale: String
    var bundleId: String
    /// True while the install id is kept on the device (`setConsent(true)`), so the server can tell installs
    /// that can come back under the same id (retention) from per-launch ids. Omitted otherwise.
    var consent: Bool? = nil
    /// `"vendor"` while events go out under the `.vendor` install id (`FounderData.InstallIDMode`) and without
    /// consent: the id comes back on later launches, so the server counts the install for retention. Omitted otherwise.
    var id: String? = nil

    enum CodingKeys: String, CodingKey {
        case platform
        case appVersion = "app_version"
        case build
        case osVersion = "os_version"
        case device
        case locale
        case bundleId = "bundle_id"
        case consent
        case id
    }
}

/// Acquisition source attached to `session_start` as `src`.
struct WireSource: Codable, Equatable, Sendable {
    var adsToken: String?
    var utmSource: String?
    var utmMedium: String?
    var utmCampaign: String?
    var utmTerm: String?
    var utmContent: String?
    var ref: String?
    /// Web visitor id from a universal link (`rt_vid`), stored server-side as `linked_web_vid`.
    var webVisitorId: String?
    /// The ad network whose click id the link carried (`google_ads`, ...), sent with `clickId`. See `ClickNetwork`.
    var clickNetwork: String?
    /// The raw click id (`gclid`, `msclkid`, ...). The server keeps it 90 days.
    var clickId: String?

    enum CodingKeys: String, CodingKey {
        case adsToken = "ads_token"
        case utmSource = "utm_source"
        case utmMedium = "utm_medium"
        case utmCampaign = "utm_campaign"
        case utmTerm = "utm_term"
        case utmContent = "utm_content"
        case ref
        case webVisitorId = "rt_vid"
        case clickNetwork = "click_network"
        case clickId = "click_id"
    }

    /// The key a queue file written under the minilytics names uses.
    private enum LegacyKeys: String, CodingKey { case webVisitorId = "ml_vid" }

    init(
        adsToken: String? = nil, utmSource: String? = nil, utmMedium: String? = nil, utmCampaign: String? = nil,
        utmTerm: String? = nil, utmContent: String? = nil, ref: String? = nil, webVisitorId: String? = nil,
        clickNetwork: String? = nil, clickId: String? = nil
    ) {
        self.adsToken = adsToken
        self.utmSource = utmSource
        self.utmMedium = utmMedium
        self.utmCampaign = utmCampaign
        self.utmTerm = utmTerm
        self.utmContent = utmContent
        self.ref = ref
        self.webVisitorId = webVisitorId
        self.clickNetwork = clickNetwork
        self.clickId = clickId
    }

    init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        adsToken = try c.decodeIfPresent(String.self, forKey: .adsToken)
        utmSource = try c.decodeIfPresent(String.self, forKey: .utmSource)
        utmMedium = try c.decodeIfPresent(String.self, forKey: .utmMedium)
        utmCampaign = try c.decodeIfPresent(String.self, forKey: .utmCampaign)
        utmTerm = try c.decodeIfPresent(String.self, forKey: .utmTerm)
        utmContent = try c.decodeIfPresent(String.self, forKey: .utmContent)
        ref = try c.decodeIfPresent(String.self, forKey: .ref)
        webVisitorId = try c.decodeIfPresent(String.self, forKey: .webVisitorId)
            ?? decoder.container(keyedBy: LegacyKeys.self).decodeIfPresent(String.self, forKey: .webVisitorId)
        clickNetwork = try c.decodeIfPresent(String.self, forKey: .clickNetwork)
        clickId = try c.decodeIfPresent(String.self, forKey: .clickId)
    }

    var isEmpty: Bool { self == WireSource() }

    /// Values from `other` win where they are set. The click network and id travel as a pair.
    func merging(_ other: WireSource) -> WireSource {
        let otherClick = other.clickId != nil
        return WireSource(
            adsToken: other.adsToken ?? adsToken,
            utmSource: other.utmSource ?? utmSource,
            utmMedium: other.utmMedium ?? utmMedium,
            utmCampaign: other.utmCampaign ?? utmCampaign,
            utmTerm: other.utmTerm ?? utmTerm,
            utmContent: other.utmContent ?? utmContent,
            ref: other.ref ?? ref,
            webVisitorId: other.webVisitorId ?? webVisitorId,
            clickNetwork: otherClick ? other.clickNetwork : clickNetwork,
            clickId: otherClick ? other.clickId : clickId
        )
    }
}

enum WireEventType: String, Codable, Sendable {
    case sessionStart = "session_start"
    case screen
    case goal
    case ping
    case identify
    case purchase
    /// The full set of session properties, sent when they change after `session_start` left the queue.
    case sessionProps = "session_props"
}

struct WireEvent: Codable, Equatable, Sendable {
    var t: WireEventType
    var sid: String
    /// Client time in Unix milliseconds.
    var ts: Int64
    var n: String?
    var p: [String: String]?
    var d: Int64?
    var jws: String?
    var src: WireSource?
    /// Session properties on `session_start` (`FounderData.setSessionProperties`).
    var sp: [String: String]?

    init(
        t: WireEventType, sid: String, ts: Int64,
        n: String? = nil, p: [String: String]? = nil, d: Int64? = nil,
        jws: String? = nil, src: WireSource? = nil, sp: [String: String]? = nil
    ) {
        self.t = t
        self.sid = sid
        self.ts = ts
        self.n = n
        self.p = p
        self.d = d
        self.jws = jws
        self.src = src
        self.sp = sp
    }
}

struct WireBatch: Codable, Equatable, Sendable {
    var w: String
    var ctx: WireContext
    var vid: String
    var events: [WireEvent]
}

enum WireCoding {
    static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        return encoder
    }
}

extension Date {
    var unixMs: Int64 { Int64((timeIntervalSince1970 * 1000).rounded()) }
}

extension String {
    /// Trims whitespace and cuts to `max` characters. Returns nil when nothing is left.
    func clipped(_ max: Int) -> String? {
        let trimmed = trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        return trimmed.count > max ? String(trimmed.prefix(max)) : trimmed
    }
}
