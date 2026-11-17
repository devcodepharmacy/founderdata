import Foundation

protocol Transport: Sendable {
    /// POSTs `body` as JSON and returns the HTTP status code.
    func post(_ body: Data, to url: URL) async throws -> Int
}

struct URLSessionTransport: Transport {
    static let session: URLSession = {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.urlCache = nil
        config.timeoutIntervalForRequest = 30
        return URLSession(configuration: config)
    }()

    func post(_ body: Data, to url: URL) async throws -> Int {
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = body
        let (_, response) = try await Self.session.data(for: request)
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }
}

enum DeliveryOutcome: Equatable {
    /// 2xx: remove the batch from the queue. A 202 with `rejected: n` means the server
    /// skipped n bad events; resending cannot fix them, so they go too.
    case delivered
    /// The server will never accept this body: 400 bad payload, 403 bundle id not allowed
    /// for this site, 413 too large. Drop it.
    case rejected
    /// Network error, 404 (site not set up yet), 429 or 5xx: keep it and back off.
    case retry

    init(status: Int) {
        switch status {
        case 200..<300: self = .delivered
        case 400, 403, 413, 422: self = .rejected
        default: self = .retry
        }
    }
}

enum Backoff {
    /// 5 s, 10 s, 20 s ... capped at 15 minutes, times a jitter factor around 1.
    static func delay(afterFailures failures: Int, jitter: Double = 1) -> TimeInterval {
        let exponent = Double(min(max(failures - 1, 0), 16))
        return min(900, 5 * pow(2, exponent)) * jitter
    }
}

enum Endpoint {
    /// `https://stats.example.com` or `stats.example.com` becomes `https://stats.example.com/api/app/events`.
    static func events(host: String) -> URL? {
        var base = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !base.isEmpty else { return nil }
        if !base.contains("://") { base = "https://" + base }
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base), url.host != nil else { return nil }
        return URL(string: base + "/api/app/events")
    }
}
