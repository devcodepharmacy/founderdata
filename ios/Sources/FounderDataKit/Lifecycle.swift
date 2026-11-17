import Foundation
import Network
#if canImport(UIKit)
import UIKit

/// Wires UIKit app state to the core: sessions, pings, the 30-second flush timer
/// and the flush on background under a background task assertion.
@MainActor
final class LifecycleObserver {
    private static var installed: LifecycleObserver?

    static func install(core: Core) {
        guard installed == nil else { return }
        let observer = LifecycleObserver(core: core)
        installed = observer
        observer.start()
    }

    private let core: Core
    private var tokens: [NSObjectProtocol] = []
    private var timer: Task<Void, Never>?

    private init(core: Core) {
        self.core = core
    }

    private func start() {
        let center = NotificationCenter.default
        observe(center, UIApplication.didBecomeActiveNotification) { $0.didBecomeActive() }
        observe(center, UIApplication.willResignActiveNotification) { $0.willResignActive() }
        observe(center, UIApplication.didEnterBackgroundNotification) { $0.didEnterBackground() }
        if UIApplication.shared.applicationState == .active {
            didBecomeActive()
        }
    }

    private func observe(
        _ center: NotificationCenter,
        _ name: Notification.Name,
        _ handler: @escaping @MainActor (LifecycleObserver) -> Void
    ) {
        let token = center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                handler(self)
            }
        }
        tokens.append(token)
    }

    private func didBecomeActive() {
        core.appBecameActive()
        startTimer()
    }

    private func willResignActive() {
        core.appResignedActive()
    }

    private func didEnterBackground() {
        timer?.cancel()
        timer = nil
        core.appEnteredBackground()

        let app = UIApplication.shared
        let assertion = BackgroundAssertion()
        assertion.id = app.beginBackgroundTask(withName: "FounderData flush") {
            assertion.end()
        }
        let core = self.core
        Task.detached(priority: .utility) {
            await core.flush(ignoreBackoff: true)
            core.saveNow()
            await MainActor.run { assertion.end() }
        }
    }

    private func startTimer() {
        timer?.cancel()
        let core = self.core
        timer = Task.detached(priority: .utility) {
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                if Task.isCancelled { break }
                core.tick()
                await core.flush()
            }
        }
    }
}

@MainActor
private final class BackgroundAssertion {
    var id: UIBackgroundTaskIdentifier = .invalid

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
#endif

/// Flushes when the network comes back after being unavailable.
final class NetworkWatcher: Sendable {
    static let shared = NetworkWatcher()

    private let monitor = NWPathMonitor()
    private let started = Locked(false)
    private let lastSatisfied = Locked(true)

    func start(core: Core) {
        let first: Bool = started.withLock { flag in
            if flag { return false }
            flag = true
            return true
        }
        guard first else { return }
        monitor.pathUpdateHandler = { [self] path in
            let satisfied = path.status == .satisfied
            let returned: Bool = self.lastSatisfied.withLock { last in
                defer { last = satisfied }
                return satisfied && !last
            }
            if returned {
                Task.detached(priority: .utility) { await core.networkReturned() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "app.founderdata.network", qos: .utility))
    }
}
