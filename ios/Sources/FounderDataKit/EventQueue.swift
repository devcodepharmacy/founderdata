import Foundation

struct QueuedEvent: Codable, Equatable, Sendable {
    var id: UInt64
    var vid: String
    var ctx: WireContext
    var event: WireEvent
}

/// One request body ready to send, with the queue ids it covers.
struct OutgoingBatch: Sendable {
    var ids: [UInt64]
    var body: Data
}

/// Offline queue. Oldest first, capped at 2,000 events, events older than 72 hours dropped.
struct EventQueue: Codable, Equatable, Sendable {
    static let maxCount = 2_000
    static let maxBatchCount = 50
    /// The server accepts 64 KB per body. Keep a margin.
    static let maxBodyBytes = 60 * 1024
    static let maxAgeMs: Int64 = 72 * 60 * 60 * 1000

    private(set) var items: [QueuedEvent] = []
    private(set) var nextId: UInt64 = 1

    var count: Int { items.count }
    var isEmpty: Bool { items.isEmpty }

    /// Appends an event and drops the oldest events beyond the cap. Returns how many were dropped.
    @discardableResult
    mutating func append(_ event: WireEvent, vid: String, ctx: WireContext) -> Int {
        items.append(QueuedEvent(id: nextId, vid: vid, ctx: ctx, event: event))
        nextId += 1
        let overflow = items.count - Self.maxCount
        guard overflow > 0 else { return 0 }
        items.removeFirst(overflow)
        return overflow
    }

    /// Drops events whose client time is more than 72 hours before `nowMs`. Returns how many were dropped.
    @discardableResult
    mutating func purgeExpired(nowMs: Int64) -> Int {
        let cutoff = nowMs - Self.maxAgeMs
        let before = items.count
        items.removeAll { $0.event.ts < cutoff }
        return before - items.count
    }

    mutating func remove(ids: [UInt64]) {
        let set = Set(ids)
        items.removeAll { set.contains($0.id) }
    }

    mutating func removeAll() {
        items.removeAll()
    }

    /// Merges `source` into the queued `session_start` of `sid`. False when that event already left the queue.
    mutating func mergeSource(_ source: WireSource, intoSessionStartOf sid: String) -> Bool {
        guard let index = items.firstIndex(where: { $0.event.t == .sessionStart && $0.event.sid == sid }) else {
            return false
        }
        let merged = (items[index].event.src ?? WireSource()).merging(source)
        items[index].event.src = merged.isEmpty ? nil : merged
        return true
    }

    /// Replaces the session properties on the queued `session_start` of `sid`. False when that event already left the queue.
    mutating func setSessionProperties(_ props: [String: String], intoSessionStartOf sid: String) -> Bool {
        guard let index = items.firstIndex(where: { $0.event.t == .sessionStart && $0.event.sid == sid }) else {
            return false
        }
        items[index].event.sp = props.isEmpty ? nil : props
        return true
    }

    /// The next request body: the oldest events sharing one `vid` and `ctx`,
    /// at most 50 of them and at most `maxBodyBytes` (always at least one event).
    func nextBatch(siteId: String, maxCount: Int = EventQueue.maxBatchCount, maxBytes: Int = EventQueue.maxBodyBytes) -> OutgoingBatch? {
        guard let first = items.first else { return nil }
        let encoder = WireCoding.encoder()
        let envelope = WireBatch(w: siteId, ctx: first.ctx, vid: first.vid, events: [])
        var bytes = (try? encoder.encode(envelope).count) ?? 512
        var chosen: [QueuedEvent] = []
        for item in items {
            guard chosen.count < maxCount, item.vid == first.vid, item.ctx == first.ctx else { break }
            let size = ((try? encoder.encode(item.event).count) ?? 0) + 1
            if !chosen.isEmpty, bytes + size > maxBytes { break }
            bytes += size
            chosen.append(item)
        }
        let batch = WireBatch(w: siteId, ctx: first.ctx, vid: first.vid, events: chosen.map(\.event))
        guard let body = try? encoder.encode(batch) else { return nil }
        return OutgoingBatch(ids: chosen.map(\.id), body: body)
    }
}
