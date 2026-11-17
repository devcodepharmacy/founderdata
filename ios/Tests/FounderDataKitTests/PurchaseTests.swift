import Foundation
import StoreKit
import Testing
@testable import FounderDataKit

/// Collects what the purchase wrapper reports.
final class PurchaseRecorder: Sendable {
    private let sent = Locked<[FounderData.GoalEvent]>([])
    private let tracked = Locked(0)

    var goals: [FounderData.GoalEvent] { sent.withLock { $0 } }
    var names: [String] { goals.map(\.name) }
    var trackedCount: Int { tracked.withLock { $0 } }

    func send(_ goal: FounderData.GoalEvent) { sent.withLock { $0.append(goal) } }
    func track(_ result: VerificationResult<Transaction>) { tracked.withLock { $0 += 1 } }
}

/// `FounderData.purchase(_:source:options:)`: one `purchase_start`, then the goal for the outcome, and StoreKit's
/// result or error passed on unchanged. The verified path needs StoreKit and is in `StoreKitPurchaseTests`.
@Suite("Purchase wrapper")
struct PurchaseTests {
    typealias Outcome = FounderData.PurchaseOutcome

    @Test func cancelledAndPendingSendTheirGoal() async throws {
        let cancelled = PurchaseRecorder()
        let first = try await FounderData.recordPurchase(product: "pro_yearly", source: .onboarding, send: cancelled.send, track: cancelled.track) {
            .userCancelled
        }
        guard case .userCancelled = first else { Issue.record("result changed: \(first)"); return }
        #expect(cancelled.names == ["purchase_start", "purchase_cancelled"])
        #expect(cancelled.goals.allSatisfy { $0.props == ["source": "onboarding", "product": "pro_yearly"] })
        #expect(cancelled.trackedCount == 0)

        let pending = PurchaseRecorder()
        let second = try await FounderData.recordPurchase(product: "pro_yearly", source: .gate("Stats"), send: pending.send, track: pending.track) {
            .pending
        }
        guard case .pending = second else { Issue.record("result changed: \(second)"); return }
        #expect(pending.names == ["purchase_start", "purchase_pending"])
        #expect(pending.goals.last?.props == ["source": "gate_stats", "product": "pro_yearly"])
        #expect(pending.trackedCount == 0)
    }

    @Test func aThrownErrorIsReportedAndThrownAgain() async {
        let cases: [(any Error, String, [String: String])] = [
            (URLError(.notConnectedToInternet), "purchase_failed", ["reason": "network"]),
            (StoreKitError.networkError(URLError(.timedOut)), "purchase_failed", ["reason": "network"]),
            (Product.PurchaseError.productUnavailable, "purchase_failed", ["reason": "store"]),
            (CocoaError(.fileNoSuchFile), "purchase_failed", ["reason": "other"]),
            (StoreKitError.userCancelled, "purchase_cancelled", [:]),
        ]
        for (original, goal, extra) in cases {
            let recorder = PurchaseRecorder()
            do {
                _ = try await FounderData.recordPurchase(product: "pro_monthly", source: "streak_banner", send: recorder.send, track: recorder.track) {
                    throw original
                }
                Issue.record("\(original) was not thrown again")
            } catch {
                #expect(String(reflecting: error) == String(reflecting: original), "a different error came back")
            }
            #expect(recorder.names == ["purchase_start", goal])
            #expect(recorder.goals.last?.props == ["source": "streak_banner", "product": "pro_monthly"].merging(extra) { $1 })
            #expect(recorder.trackedCount == 0)
        }
    }

    @Test func theSameErrorComesBack() async {
        let recorder = PurchaseRecorder()
        do {
            _ = try await FounderData.recordPurchase(product: "p", source: .settings, send: recorder.send, track: recorder.track) {
                throw URLError(.timedOut)
            }
        } catch let error as URLError {
            #expect(error.code == .timedOut)
        } catch {
            Issue.record("expected the URLError, got \(error)")
        }
    }

    @Test func outcomesMapToTheDocumentedGoals() {
        #expect(Outcome(Product.PurchaseResult.userCancelled) == .cancelled)
        #expect(Outcome(Product.PurchaseResult.pending) == .pending)
        #expect(Outcome(error: StoreKitError.userCancelled) == .cancelled)
        #expect(Outcome(error: StoreKitError.notEntitled) == .failed(.store))
        #expect(Outcome(error: VerificationResult<Transaction>.VerificationError.invalidSignature) == .failed(.verification))

        #expect(Outcome.purchased.goal(product: "p", source: .settings) == nil)
        #expect(Outcome.cancelled.goal(product: "p", source: .settings)?.name == "purchase_cancelled")
        #expect(Outcome.pending.goal(product: "p", source: .settings)?.name == "purchase_pending")
        #expect(Outcome.failed(.verification).goal(product: "p", source: .settings)
            == FounderData.GoalEvent("purchase_failed", ["source": "settings", "product": "p", "reason": "verification"]))
    }
}

/// `FounderData.flush()`: send now, past the wait after a failed upload.
@Suite("Public flush")
struct FlushTests {
    @Test func flushSkipsTheBackoffAndReturnsTheAcceptedCount() async {
        let h = Harness(persistent: false)
        h.core.record(.screen("Paywall"))
        h.transport.script([-1])
        #expect(await h.core.flush() == 0)
        #expect(await h.core.flush() == 0)
        #expect(h.transport.bodies.count == 1, "the second automatic flush waits out the backoff")

        #expect(await FounderData.flush(h.core) == 2)
        #expect(h.queued.isEmpty)
        #expect(h.transport.bodies.count == 2)
        #expect(await FounderData.flush(h.core) == 0)
    }

    @Test func flushBeforeConfigureSendsNothing() async {
        #expect(await FounderData.flush(nil) == 0)
    }
}

/// `configure` stops a Debug build on arguments that would send nothing, or send over plain http.
@Suite("Configure checks")
struct ConfigureCheckTests {
    private func problems(_ siteId: String = "site_1", host: String = "https://founderdata.example.com", debugHost: String? = nil) -> [String] {
        FounderData.configurationProblems(siteId: siteId, host: host, debugHost: debugHost)
    }

    @Test func goodArgumentsPass() {
        #expect(problems().isEmpty)
        #expect(problems(host: "founderdata.example.com").isEmpty)
        #expect(problems(debugHost: "http://localhost:8787").isEmpty)
        for local in ["http://127.0.0.1:9", "http://192.168.1.20:8787", "http://10.0.0.5", "http://172.20.1.1:8787",
                      "http://macbook.local:8787", "http://[::1]:8787"] {
            #expect(problems(host: local).isEmpty, "\(local)")
        }
    }

    @Test func emptySiteIdAndPlainHttpAreProblems() {
        #expect(problems("  ").count == 1)
        #expect(problems(host: "http://founderdata.example.com").count == 1)
        #expect(problems(host: "http://10.example.com").count == 1)
        #expect(problems(host: "http://172.32.0.1").count == 1)
        #expect(problems(host: "ftp://founderdata.example.com").count == 1)
        #expect(problems(host: "").count == 1)
        #expect(problems(debugHost: "http://staging.example.com").first?.hasPrefix("debugHost") == true)
        #expect(problems("", host: "http://founderdata.example.com").count == 2)
    }
}
