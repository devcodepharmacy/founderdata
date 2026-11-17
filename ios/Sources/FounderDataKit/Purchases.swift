import Foundation
import StoreKit

extension FounderData {
    private static let observingTransactions = Locked(false)

    /// Reports a StoreKit 2 purchase. Pass the `VerificationResult` you got from
    /// `product.purchase(...)` or from `Transaction.updates`.
    ///
    /// Only verified, unrevoked transactions are sent, each once. The SDK sends
    /// `jwsRepresentation`; the server checks Apple's signature again, reads price and
    /// currency from it, and deduplicates by transaction id. Refunds reach the server
    /// through App Store Server Notifications, not through the app. The SDK never logs the JWS.
    public static func track(purchase result: VerificationResult<Transaction>) {
        guard case .verified(let transaction) = result else {
            sdkLog.notice("FounderData skipped an unverified transaction")
            return
        }
        guard transaction.revocationDate == nil else { return }
        current?.record(.purchase(jws: result.jwsRepresentation, dedupeKey: String(transaction.id)))
    }

    /// Buys `product` with StoreKit 2 and reports the attempt. Call it where you would call
    /// `product.purchase(options:)`.
    ///
    /// It adds `.appAccountToken(FounderData.appAccountToken)` to `options` and sends `purchase_start`. Then it sends
    /// one goal for the outcome: `purchase_cancelled`, `purchase_pending`, or `purchase_failed` with a `reason`
    /// (`verification` for an unverified transaction). A verified purchase sends no goal; `track(purchase:)` reports
    /// the transaction itself. An error from StoreKit is reported (`StoreKitError.userCancelled` as
    /// `purchase_cancelled`) and thrown again unchanged.
    ///
    /// The result is StoreKit's, unchanged: deliver the content and call `finish()` as before. Leave
    /// `.appAccountToken` out of `options`; FounderData adds its own to credit renewals to this install.
    public static func purchase(
        _ product: Product,
        source: PaywallSource,
        options: Set<Product.PurchaseOption> = []
    ) async throws -> Product.PurchaseResult {
        try await purchase(product, source: source, options: options, token: appAccountToken, send: send, track: { track(purchase: $0) })
    }

    /// `purchase(_:source:options:)` with the token and the reporting passed in, for tests.
    static func purchase(
        _ product: Product,
        source: PaywallSource,
        options: Set<Product.PurchaseOption>,
        token: UUID,
        send: (GoalEvent) -> Void,
        track: (VerificationResult<Transaction>) -> Void
    ) async throws -> Product.PurchaseResult {
        let all = options.union([.appAccountToken(token)])
        return try await recordPurchase(product: product.id, source: source, send: send, track: track) {
            try await product.purchase(options: all)
        }
    }

    /// Sends `purchase_start`, runs `buy`, reports what it returned or threw, and passes it on.
    static func recordPurchase(
        product: String,
        source: PaywallSource,
        send: (GoalEvent) -> Void,
        track: (VerificationResult<Transaction>) -> Void,
        buy: () async throws -> Product.PurchaseResult
    ) async throws -> Product.PurchaseResult {
        send(.purchase("purchase_start", product: product, source: source))
        let result: Product.PurchaseResult
        do {
            result = try await buy()
        } catch {
            if let goal = PurchaseOutcome(error: error).goal(product: product, source: source) { send(goal) }
            throw error
        }
        if case .success(let verification) = result { track(verification) }
        if let goal = PurchaseOutcome(result)?.goal(product: product, source: source) { send(goal) }
        return result
    }

    /// How a purchase attempt ended. `trackPurchase(product:source:_:)` takes it from your purchase code and
    /// sends the matching goal.
    public enum PurchaseOutcome: Equatable, Sendable {
        /// The purchase went through. No goal: the transaction itself reaches FounderData through
        /// `track(purchase:)`, App Store Server Notifications or the RevenueCat webhook.
        case purchased
        /// The user closed the payment sheet: `purchase_cancelled`.
        case cancelled
        /// Waiting for approval (Ask to Buy, Strong Customer Authentication): `purchase_pending`.
        case pending
        /// The purchase failed: `purchase_failed` with `reason`.
        case failed(PurchaseFailureReason)

        /// Nil for a `PurchaseResult` case added to StoreKit after this SDK.
        init?(_ result: Product.PurchaseResult) {
            switch result {
            case .success(.verified(_)): self = .purchased
            case .success(.unverified(_, _)): self = .failed(.verification)
            case .userCancelled: self = .cancelled
            case .pending: self = .pending
            @unknown default: return nil
            }
        }

        /// Sorts an error thrown by StoreKit or RevenueCat. Cancelling is `cancelled`, RevenueCat's
        /// `paymentPendingError` is `pending`, anything else `failed` with `PurchaseFailureReason(error)`.
        init(error: any Error) {
            if let storeKit = error as? StoreKitError, case .userCancelled = storeKit {
                self = .cancelled
            } else if let code = RevenueCatError.code(error), code == RevenueCatError.purchaseCancelled {
                self = .cancelled
            } else if let code = RevenueCatError.code(error), code == RevenueCatError.paymentPending {
                self = .pending
            } else {
                self = .failed(PurchaseFailureReason(error))
            }
        }

        func goal(product: String, source: PaywallSource) -> GoalEvent? {
            switch self {
            case .purchased: return nil
            case .cancelled: return .purchase("purchase_cancelled", product: product, source: source)
            case .pending: return .purchase("purchase_pending", product: product, source: source)
            case .failed(let reason): return .purchaseFailed(product: product, source: source, reason: reason)
            }
        }
    }

    /// Reports a purchase made by your own code, for example RevenueCat's `Purchases.shared.purchase(package:)`.
    /// Sends `purchase_start`, runs `perform`, then the goal for the outcome it returns, the same goals as
    /// `purchase(_:source:options:)`:
    ///
    /// ```swift
    /// try await FounderData.trackPurchase(product: package.storeProduct.productIdentifier, source: .onboarding) {
    ///     let result = try await Purchases.shared.purchase(package: package)
    ///     return result.userCancelled ? .cancelled : .purchased
    /// }
    /// ```
    ///
    /// An error thrown by `perform` is reported and thrown again unchanged: RevenueCat's
    /// `purchaseCancelledError` and `StoreKitError.userCancelled` as `purchase_cancelled`, `paymentPendingError` as
    /// `purchase_pending`, anything else as `purchase_failed` with a `reason` (`network` for RevenueCat's
    /// `networkError`, `store` for its other errors). `perform` runs on the caller's actor. Unlock content inside it.
    @discardableResult
    nonisolated(nonsending) public static func trackPurchase(
        product: String,
        source: PaywallSource,
        _ perform: () async throws -> PurchaseOutcome
    ) async rethrows -> PurchaseOutcome {
        try await trackPurchase(product: product, source: source, send: send, perform: perform)
    }

    /// `trackPurchase(product:source:_:)` with the reporting passed in, for tests.
    nonisolated(nonsending) static func trackPurchase(
        product: String,
        source: PaywallSource,
        send: (GoalEvent) -> Void,
        perform: () async throws -> PurchaseOutcome
    ) async rethrows -> PurchaseOutcome {
        send(.purchase("purchase_start", product: product, source: source))
        let outcome: PurchaseOutcome
        do {
            outcome = try await perform()
        } catch {
            if let goal = PurchaseOutcome(error: error).goal(product: product, source: source) { send(goal) }
            throw error
        }
        if let goal = outcome.goal(product: product, source: source) { send(goal) }
        return outcome
    }

    /// The RevenueCat subscriber attribute that links a purchase to this install:
    /// `["founderDataVisitorId": <appAccountToken, lowercase>]`. RevenueCat sends it with every webhook event, and
    /// FounderData credits the purchase to the install and session. Pass it to
    /// `Purchases.shared.attribution.setAttributes(_:)` after configuring RevenueCat, after `logIn`, after
    /// `FounderData.reset()` and before each purchase. Without consent the id changes on every launch, so set it
    /// on every launch.
    public static var revenueCatAttributes: [String: String] {
        [revenueCatAttributeKey: appAccountToken.uuidString.lowercased()]
    }

    /// The attribute name `src/worker/revenuecat.ts` reads. RevenueCat reserves names that start with `$`.
    static let revenueCatAttributeKey = "founderDataVisitorId"

    /// Listens to `Transaction.updates` for the rest of the app's life and reports every
    /// verified transaction: renewals, purchases made on another device and Ask to Buy
    /// approvals. Calling it twice has no extra effect.
    ///
    /// This listener does not call `finish()`. Your own `Transaction.updates` loop
    /// still delivers content and finishes transactions.
    public static func observeTransactions() {
        let first: Bool = observingTransactions.withLock { observing in
            if observing { return false }
            observing = true
            return true
        }
        guard first else { return }
        Task.detached(priority: .utility) {
            for await update in Transaction.updates {
                track(purchase: update)
            }
        }
    }
}

/// RevenueCat's `ErrorCode` without a dependency on RevenueCat: its errors bridge to `NSError` with this domain and
/// the `ErrorCode` raw value as code.
enum RevenueCatError {
    static let domains: Set<String> = ["RevenueCat.ErrorCode", "RCPurchasesErrorCodeDomain"]
    static let purchaseCancelled = 1
    static let network = 10
    static let paymentPending = 20

    /// The `ErrorCode` raw value, or nil for an error that is not RevenueCat's.
    static func code(_ error: any Error) -> Int? {
        let ns = error as NSError
        return domains.contains(ns.domain) ? ns.code : nil
    }
}
