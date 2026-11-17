import Foundation
import StoreKit
import Testing
@testable import FounderDataKit

/// The typed helpers send the goal names and props that docs/APP-EVENTS.md defines.
@Suite("Typed goal helpers")
struct GoalsTests {
    typealias Goal = FounderData.GoalEvent

    @Test func paywallAndPurchaseGoals() {
        let view = Goal.paywallView(source: .onboarding, paywall: nil)
        #expect(view.name == "paywall_view")
        #expect(view.props == ["source": "onboarding"])
        #expect(Goal.paywallView(source: .gate("Stats Screen"), paywall: "annual_first").props
            == ["source": "gate_stats_screen", "paywall": "annual_first"])

        for name in ["purchase_start", "purchase_cancelled", "purchase_pending"] {
            let goal = Goal.purchase(name, product: "pro_yearly", source: .settings)
            #expect(goal.name == name)
            #expect(goal.props == ["source": "settings", "product": "pro_yearly"])
        }
        let failed = Goal.purchaseFailed(product: "pro_yearly", source: "streak_banner", reason: .network)
        #expect(failed.name == "purchase_failed")
        #expect(failed.props == ["source": "streak_banner", "product": "pro_yearly", "reason": "network"])
        #expect(FounderData.PaywallSource.featureGate.rawValue == "feature_gate")
    }

    @Test func onboardingFlowActivationAndPermissionGoals() {
        #expect(Goal.onboardingSkip(step: "Notifications") == Goal("onboarding_skip", ["step": "notifications"]))
        #expect(Goal("activation", ["what": nil]).props.isEmpty)
        #expect(Goal.permissionPrompt("Notifications")?.name == "permission_notifications_prompt")
        let answer = Goal.permission("photos", result: .limited)
        #expect(answer?.name == "permission_photos")
        #expect(answer?.props == ["result": "limited"])
        #expect(Goal.permissionPrompt("--") == nil)
    }

    @Test func failureReasonsFromErrors() {
        typealias Reason = FounderData.PurchaseFailureReason
        #expect(Reason(URLError(.timedOut)) == .network)
        #expect(Reason(StoreKitError.networkError(URLError(.notConnectedToInternet))) == .network)
        #expect(Reason(StoreKitError.notEntitled) == .store)
        #expect(Reason(Product.PurchaseError.productUnavailable) == .store)
        #expect(Reason(VerificationResult<Transaction>.VerificationError.invalidSignature) == .verification)
        #expect(Reason(CocoaError(.fileNoSuchFile)) == .other)
    }

    /// Every name a helper sends is documented, so a rename on either side fails here.
    @Test func everyHelperGoalIsInTheEventDoc() throws {
        let doc = try String(contentsOf: repoRoot.appendingPathComponent("docs/APP-EVENTS.md"), encoding: .utf8)
        let names = [
            "paywall_view", "purchase_start", "purchase_cancelled", "purchase_pending", "purchase_failed",
            "restore_start", "restore_success", "onboarding_skip", "flow_start", "flow_exit", "activation",
            "permission_<kind>_prompt", "permission_<kind>",
        ]
        for name in names {
            #expect(doc.contains("`\(name)`"), "\(name) is missing from docs/APP-EVENTS.md")
        }
        for reason in FounderData.PurchaseFailureReason.allCases {
            #expect(doc.contains("`\(reason.rawValue)`"))
        }
        for result in FounderData.PermissionResult.allCases {
            #expect(doc.contains("`\(result.rawValue)`"))
        }
    }

    @Test func revenueCatAttributeMatchesTheServer() throws {
        let attributes = FounderData.revenueCatAttributes
        #expect(Array(attributes.keys) == ["founderDataVisitorId"])
        let value = try #require(attributes["founderDataVisitorId"])
        #expect(value == value.lowercased())
        #expect(UUID(uuidString: value) != nil)
        // src/worker/revenuecat.ts reads this key.
        let worker = try String(contentsOf: repoRoot.appendingPathComponent("src/worker/revenuecat.ts"), encoding: .utf8)
        #expect(worker.contains("attrs.\(FounderData.revenueCatAttributeKey)"))
    }
}

/// The repository root: this file is ios/Tests/FounderDataKitTests/GoalsTests.swift.
let repoRoot = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
