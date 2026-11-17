import Foundation
import StoreKit
import StoreKitTest
import XCTest
@testable import FounderDataKit

/// `FounderData.purchase(_:source:options:)` against a local StoreKit test session (`FounderDataKitTests.storekit`):
/// the verified purchase, Ask to Buy, a StoreKit error and an unverified transaction. Skipped where StoreKit
/// testing is not available and the product does not load.
final class StoreKitPurchaseTests: XCTestCase {
    private static let productId = "app.founderdata.tests.pro_lifetime"
    private static let configuration = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().appendingPathComponent("FounderDataKitTests.storekit")

    private func start() async throws -> (SKTestSession, Product) {
        let session = try SKTestSession(contentsOf: Self.configuration)
        session.resetToDefaultState()
        session.disableDialogs = true
        session.clearTransactions()
        let products = (try? await Product.products(for: [Self.productId])) ?? []
        guard let product = products.first else {
            throw XCTSkip("StoreKit testing is not available here: \(Self.productId) did not load.")
        }
        return (session, product)
    }

    private func buy(_ product: Product, _ recorder: PurchaseRecorder, token: UUID = UUID()) async throws -> Product.PurchaseResult {
        try await FounderData.purchase(product, source: .onboarding, options: [], token: token, send: recorder.send, track: recorder.track)
    }

    func testVerifiedPurchaseCarriesTheTokenAndIsTracked() async throws {
        let (session, product) = try await start()
        defer { session.clearTransactions() }
        let token = UUID()
        let recorder = PurchaseRecorder()

        let result = try await buy(product, recorder, token: token)

        guard case .success(.verified(let transaction)) = result else { return XCTFail("expected a verified purchase, got \(result)") }
        XCTAssertEqual(transaction.productID, Self.productId)
        XCTAssertEqual(transaction.appAccountToken, token)
        XCTAssertEqual(recorder.names, ["purchase_start"])
        XCTAssertEqual(recorder.goals.first?.props, ["source": "onboarding", "product": Self.productId])
        XCTAssertEqual(recorder.trackedCount, 1)
        await transaction.finish()
    }

    func testAskToBuySendsPending() async throws {
        let (session, product) = try await start()
        defer { session.clearTransactions() }
        session.askToBuyEnabled = true
        let recorder = PurchaseRecorder()

        let result = try await buy(product, recorder)

        guard case .pending = result else { return XCTFail("expected pending, got \(result)") }
        XCTAssertEqual(recorder.names, ["purchase_start", "purchase_pending"])
        XCTAssertEqual(recorder.trackedCount, 0)
    }

    func testStoreKitErrorIsReportedAndThrown() async throws {
        let (session, product) = try await start()
        defer { session.clearTransactions() }
        try await session.setSimulatedError(.purchase(.productUnavailable), forAPI: .purchase)
        let recorder = PurchaseRecorder()

        do {
            _ = try await buy(product, recorder)
            XCTFail("the purchase should have thrown")
        } catch let error as Product.PurchaseError {
            XCTAssertEqual(error, .productUnavailable)
        }
        XCTAssertEqual(recorder.names, ["purchase_start", "purchase_failed"])
        XCTAssertEqual(recorder.goals.last?.props["reason"], "store")
        try await session.setSimulatedError(nil, forAPI: .purchase)
    }

    func testUnverifiedTransactionIsAFailedPurchase() async throws {
        let (session, product) = try await start()
        defer { session.clearTransactions() }
        try await session.setSimulatedError(.verification(.invalidSignature), forAPI: .verification)
        let recorder = PurchaseRecorder()

        let result = try await buy(product, recorder)

        guard case .success(.unverified(let transaction, _)) = result else { return XCTFail("expected an unverified result, got \(result)") }
        XCTAssertEqual(recorder.names, ["purchase_start", "purchase_failed"])
        XCTAssertEqual(recorder.goals.last?.props["reason"], "verification")
        XCTAssertEqual(recorder.trackedCount, 1, "track(purchase:) sees the result and skips it")
        await transaction.finish()
        try await session.setSimulatedError(nil, forAPI: .verification)
    }
}
