import os

/// A value guarded by an unfair lock, with the `withLock` shape of `Synchronization.Mutex`.
///
/// `Mutex` needs iOS 18. This wrapper runs on iOS 16 and later, so apps that target
/// iOS 17 can use the package. The closure runs while the lock is held: keep it short
/// and never await or call back into the same lock from inside it.
final class Locked<Value>: @unchecked Sendable {
    private let lock: OSAllocatedUnfairLock<Value>

    init(_ initial: Value) {
        lock = OSAllocatedUnfairLock(uncheckedState: initial)
    }

    func withLock<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLockUnchecked(body)
    }
}
