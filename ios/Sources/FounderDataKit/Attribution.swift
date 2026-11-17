import Foundation
#if canImport(AdServices)
import AdServices
#endif

/// Ad networks that add a click id to the link, in the server's order (src/shared/sources.ts, CLICK_NETWORKS): when a link
/// carries two, the first network here wins. Meta's fbclid is not here: Meta adds it to organic link clicks too.
enum ClickNetwork: String, CaseIterable, Sendable {
    case googleAds = "google_ads"
    case microsoftAds = "microsoft_ads"
    case tiktokAds = "tiktok_ads"
    case xAds = "x_ads"
    case linkedinAds = "linkedin_ads"
    case redditAds = "reddit_ads"
    case snapchatAds = "snapchat_ads"
    case pinterestAds = "pinterest_ads"

    /// Query parameter names, lowercase.
    var parameters: [String] {
        switch self {
        case .googleAds: ["gclid", "gbraid", "wbraid"]
        case .microsoftAds: ["msclkid"]
        case .tiktokAds: ["ttclid"]
        case .xAds: ["twclid"]
        case .linkedinAds: ["li_fat_id"]
        case .redditAds: ["rdt_cid"]
        case .snapchatAds: ["sccid"]
        case .pinterestAds: ["epik"]
        }
    }

    /// The server's click id rule: 8 to 500 printable ASCII characters without spaces or braces. A `+` that arrived
    /// as a space is put back. Braces mean an unfilled macro such as `{gclid}`.
    static func validClickId(_ raw: String) -> String? {
        let v = raw.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "+")
        guard (8...500).contains(v.unicodeScalars.count) else { return nil }
        let ok = v.unicodeScalars.allSatisfy { s in (0x21...0x7A).contains(s.value) || s == "|" || s == "~" }
        return ok ? v : nil
    }

    /// The first valid click id `values` (lowercased names) carry, by network order, then parameter order.
    static func click(in values: [String: String]) -> (network: ClickNetwork, id: String)? {
        for network in allCases {
            for name in network.parameters {
                if let raw = values[name], let id = validClickId(raw) { return (network, id) }
            }
        }
        return nil
    }
}

/// Reads utm_*, ref, rt_vid (or the older ml_vid) and ad click ids (gclid, msclkid, ...) from a deep link or universal link.
enum LinkAttribution {
    static let maxValueLength = 200

    static func source(from url: URL) -> WireSource? {
        guard let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { return nil }
        var values: [String: String] = [:]
        var clickValues: [String: String] = [:]
        let clickNames = Set(ClickNetwork.allCases.flatMap(\.parameters))
        for item in items {
            let key = item.name.lowercased()
            if clickNames.contains(key) {
                // Never clipped: a cut id would not match the network's. An invalid one leaves room for a later one.
                guard clickValues[key] == nil, let value = item.value.flatMap(ClickNetwork.validClickId) else { continue }
                clickValues[key] = value
                continue
            }
            guard values[key] == nil, let value = item.value?.clipped(maxValueLength) else { continue }
            values[key] = value
        }
        let click = ClickNetwork.click(in: clickValues)
        let source = WireSource(
            utmSource: values["utm_source"],
            utmMedium: values["utm_medium"],
            utmCampaign: values["utm_campaign"],
            utmTerm: values["utm_term"],
            utmContent: values["utm_content"],
            ref: values["ref"],
            webVisitorId: (values["rt_vid"] ?? values["ml_vid"]).flatMap(validVisitorId),
            clickNetwork: click?.network.rawValue,
            clickId: click?.id
        )
        return source.isEmpty ? nil : source
    }

    /// The server accepts visitor ids of 8 to 64 characters from [A-Za-z0-9_-].
    static func validVisitorId(_ raw: String) -> String? {
        guard (8...64).contains(raw.count) else { return nil }
        let allowed = Set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-")
        return raw.allSatisfy(allowed.contains) ? raw : nil
    }
}

/// Apple Ads attribution token. Generated on device, no IDFA and no ATT prompt involved.
enum AdsAttribution {
    static func token() -> String? {
        #if canImport(AdServices) && !targetEnvironment(simulator)
        return try? AAAttribution.attributionToken()
        #else
        return nil
        #endif
    }
}
