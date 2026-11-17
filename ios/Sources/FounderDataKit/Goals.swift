import Foundation
import StoreKit

// Typed helpers for the goal names the dashboard reads (docs/APP-EVENTS.md, sections 3 to 6). Each one sends
// one goal through `FounderData.goal(_:props:)`, so the string API keeps working next to them.

extension FounderData {
    /// Where a paywall opened, the `source` prop. Keep a short, fixed list per app: the paywall panels group by it.
    /// A string literal works too: `FounderData.paywallViewed(source: "streak_banner")`.
    public struct PaywallSource: RawRepresentable, ExpressibleByStringLiteral, Hashable, Sendable {
        public let rawValue: String

        public init(rawValue: String) { self.rawValue = rawValue }
        public init(stringLiteral value: String) { self.init(rawValue: value) }

        /// The paywall inside first-run onboarding.
        public static let onboarding = PaywallSource(rawValue: "onboarding")
        /// The upgrade entry in the app's settings.
        public static let settings = PaywallSource(rawValue: "settings")
        /// A locked feature, when the app does not tell them apart.
        public static let featureGate = PaywallSource(rawValue: "feature_gate")

        /// One locked feature: `.gate("Stats")` is `gate_stats`.
        public static func gate(_ feature: String) -> PaywallSource {
            PaywallSource(rawValue: "gate_" + (FounderData.propertyKey(feature, maxLength: 60) ?? "feature"))
        }
    }

    /// The `reason` prop of `purchase_failed`.
    public enum PurchaseFailureReason: String, Sendable, CaseIterable {
        case network, store, verification, other

        /// Sorts an error from `product.purchase()` or RevenueCat: `URLError`, `StoreKitError.networkError` and
        /// RevenueCat's `networkError` are `network`, other StoreKit and RevenueCat errors are `store`, a failed
        /// `VerificationResult` is `verification`, the rest `other`. Report `StoreKitError.userCancelled` with
        /// `purchaseCancelled` instead.
        public init(_ error: any Error) {
            if let code = RevenueCatError.code(error) {
                self = code == RevenueCatError.network ? .network : .store
                return
            }
            switch error {
            case is URLError:
                self = .network
            case let error as StoreKitError:
                if case .networkError = error { self = .network } else { self = .store }
            case is Product.PurchaseError:
                self = .store
            case is VerificationResult<Transaction>.VerificationError:
                self = .verification
            default:
                self = .other
            }
        }
    }

    /// The `result` prop of `permission_<kind>`.
    public enum PermissionResult: String, Sendable, CaseIterable {
        case granted, denied, limited
    }

    // MARK: Paywall and purchase

    /// The paywall became visible: the goal `paywall_view` with `source`, and `paywall` when you pass an id or variant.
    public static func paywallViewed(source: PaywallSource, paywall: String? = nil) {
        send(.paywallView(source: source, paywall: paywall))
    }

    /// The buy button was pressed: `purchase_start` with `source` and `product` (the App Store product id).
    public static func purchaseStarted(product: String, source: PaywallSource) {
        send(.purchase("purchase_start", product: product, source: source))
    }

    /// StoreKit answered `.userCancelled`, or the payment sheet was dismissed: `purchase_cancelled`.
    public static func purchaseCancelled(product: String, source: PaywallSource) {
        send(.purchase("purchase_cancelled", product: product, source: source))
    }

    /// StoreKit answered `.pending` (Ask to Buy, Strong Customer Authentication): `purchase_pending`.
    public static func purchasePending(product: String, source: PaywallSource) {
        send(.purchase("purchase_pending", product: product, source: source))
    }

    /// The purchase threw an error or failed verification: `purchase_failed` with `reason`.
    /// `PurchaseFailureReason(error)` sorts a StoreKit error.
    public static func purchaseFailed(product: String, source: PaywallSource, reason: PurchaseFailureReason) {
        send(.purchaseFailed(product: product, source: source, reason: reason))
    }

    /// The user pressed restore purchases: `restore_start`.
    public static func restoreStarted(source: PaywallSource) {
        send(GoalEvent("restore_start", ["source": source.rawValue]))
    }

    /// Restore found a purchase to give back: `restore_success`.
    public static func restoreSucceeded(source: PaywallSource) {
        send(GoalEvent("restore_success", ["source": source.rawValue]))
    }

    // MARK: Onboarding, flow, activation, permissions

    /// The user skipped the rest of onboarding at step `step`: `onboarding_skip` with `step`. The step name
    /// becomes lowercase `a-z`, `0-9` and `_`, the same as in `onboardingStep(_:_:)`.
    public static func onboardingSkipped(at step: String) {
        send(.onboardingSkip(step: step))
    }

    /// The user started the task that leads to buying: `flow_start`. Send it once per session.
    public static func flowStarted() {
        send(GoalEvent("flow_start"))
    }

    /// The user left that task without finishing it: `flow_exit` with `step`.
    public static func flowExited(at step: String) {
        send(GoalEvent("flow_exit", ["step": step]))
    }

    /// The user first got the app's core value in this launch: `activation`, with `what` when you pass it.
    /// Use one fixed `what` per app, for example `"first_habit"`.
    public static func activation(_ what: String? = nil) {
        send(GoalEvent("activation", ["what": what]))
    }

    /// The system permission prompt for `kind` (`"notifications"`, `"photos"`) is on screen: `permission_<kind>_prompt`.
    public static func permissionPrompted(_ kind: String) {
        guard let event = GoalEvent.permissionPrompt(kind) else { return }
        send(event)
    }

    /// The user answered the prompt for `kind`: `permission_<kind>` with `result`.
    public static func permissionAnswered(_ kind: String, result: PermissionResult) {
        guard let event = GoalEvent.permission(kind, result: result) else { return }
        send(event)
    }

    // MARK: Internals

    /// A goal name and its props. Nil props are left out.
    struct GoalEvent: Equatable, Sendable {
        var name: String
        var props: [String: String]

        init(_ name: String, _ props: [String: String?] = [:]) {
            self.name = name
            self.props = props.compactMapValues { $0 }
        }

        static func paywallView(source: PaywallSource, paywall: String?) -> GoalEvent {
            GoalEvent("paywall_view", ["source": source.rawValue, "paywall": paywall])
        }

        static func purchase(_ name: String, product: String, source: PaywallSource) -> GoalEvent {
            GoalEvent(name, ["source": source.rawValue, "product": product])
        }

        static func purchaseFailed(product: String, source: PaywallSource, reason: PurchaseFailureReason) -> GoalEvent {
            GoalEvent("purchase_failed", ["source": source.rawValue, "product": product, "reason": reason.rawValue])
        }

        static func onboardingSkip(step: String) -> GoalEvent {
            GoalEvent("onboarding_skip", ["step": FounderData.propertyKey(step, maxLength: 53)])
        }

        static func permissionPrompt(_ kind: String) -> GoalEvent? {
            FounderData.propertyKey(kind, maxLength: 60).map { GoalEvent("permission_\($0)_prompt") }
        }

        static func permission(_ kind: String, result: PermissionResult) -> GoalEvent? {
            FounderData.propertyKey(kind, maxLength: 60).map { GoalEvent("permission_\($0)", ["result": result.rawValue]) }
        }
    }

    static func send(_ event: GoalEvent) {
        goal(event.name, props: event.props)
    }
}
