import Foundation
@testable import FounderDataKit

/// 2025-10-25T13:46:40Z, the contract's first timestamp.
let t0 = Date(timeIntervalSince1970: 1_761_400_000)

final class TestClock: Sendable {
    private let value: Locked<Date>
    init(_ start: Date = t0) { value = Locked(start) }
    var now: Date { value.withLock { $0 } }
    func advance(_ seconds: TimeInterval) { value.withLock { $0 = $0.addingTimeInterval(seconds) } }
}

final class FakeTransport: Transport {
    private let scripted = Locked<[Int]>([])
    private let sent = Locked<[Data]>([])

    /// Statuses returned in order; 202 once the list is used up. -1 throws a network error.
    func script(_ statuses: [Int]) { scripted.withLock { $0 = statuses } }
    var bodies: [Data] { sent.withLock { $0 } }
    var batches: [WireBatch] { bodies.compactMap { try? JSONDecoder().decode(WireBatch.self, from: $0) } }

    func post(_ body: Data, to url: URL) async throws -> Int {
        sent.withLock { $0.append(body) }
        let status: Int = scripted.withLock { list in list.isEmpty ? 202 : list.removeFirst() }
        if status == -1 { throw URLError(.notConnectedToInternet) }
        return status
    }
}

final class Counter: Sendable {
    private let value = Locked(0)
    func next() -> String { value.withLock { $0 += 1; return "s\($0)" } }
}

extension WireContext {
    static let fixture = WireContext(
        appVersion: "1.4.0", build: "57", osVersion: "26.1",
        device: "iPhone17,1", locale: "en_US", bundleId: "com.example.shipkit"
    )
}

struct Harness {
    let clock = TestClock()
    let transport = FakeTransport()
    let ids = Counter()
    let directory: URL
    let core: Core

    init(directory: URL? = nil, enabled: Bool = true, persistent: Bool = true, vendorInstallId: String? = nil) {
        let dir = directory ?? FileManager.default.temporaryDirectory
            .appendingPathComponent("founderdata-tests-\(UUID().uuidString)", isDirectory: true)
        self.directory = dir
        core = Harness.makeCore(
            directory: dir, clock: clock, transport: transport, ids: ids, enabled: enabled, persistent: persistent,
            vendorInstallId: vendorInstallId
        )
    }

    /// `vendorInstallId`: the `.vendor` mode id, which is then also the id the core starts with.
    static func makeCore(
        directory: URL, clock: TestClock, transport: FakeTransport, ids: Counter, enabled: Bool = true, persistent: Bool = true,
        vendorInstallId: String? = nil
    ) -> Core {
        Core(configuration: Core.Configuration(
            siteId: "site_1",
            endpoint: URL(string: "https://stats.example.com/api/app/events")!,
            installId: vendorInstallId ?? "6f1c2b9e-0d4a-4e57-9a0b-3c2d1e0f9a8b",
            context: .fixture,
            store: persistent ? StateStore(fileURL: directory.appendingPathComponent("state.json")) : nil,
            transport: transport,
            now: { clock.now },
            enabled: enabled,
            jitter: { 1 },
            makeSessionId: { ids.next() },
            saveDelay: 3_600,
            flushAfterPurchase: false,
            vendorInstallId: vendorInstallId
        ))
    }

    var stateFile: URL { directory.appendingPathComponent("state.json") }

    var queued: [WireEvent] { core.snapshot.queue.items.map(\.event) }

    func cleanUp() { try? FileManager.default.removeItem(at: directory) }
}
