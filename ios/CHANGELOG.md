# FounderDataKit changelog

Changes to the Swift package in `ios/`. The server, the dashboard and the
iPhone app in `pro/apps/ios/` (FounderData Pro) are not listed here. Versions follow the policy in
[README.md](README.md#versions): tags in plain semver (`0.1.0`), and until
1.0.0 a minor release may change the public API.

## Unreleased

Changes since the first public commit. The first tag will be `0.1.0`.

### Changed

- Renamed from RevtrailKit to FounderDataKit, with the project: the
  module, the `FounderData` type, `.founderDataScreen` and the RevenueCat
  attribute `founderDataVisitorId`. The Keychain item, the queue folder and
  the `.vendor` install id have new names too, so an app updated from
  RevtrailKit starts with new install ids.

### Added

- `handle(url:)` reads ad click ids from links: `gclid`, `gbraid`, `wbraid`,
  `msclkid`, `ttclid`, `twclid`, `li_fat_id`, `rdt_cid`, `ScCid` and `epik`.
  The session's `src` carries `click_network` and `click_id`, and the server
  counts it as Paid with the network as its source (docs/APP-API.md, point 11).

- `configure(siteId:host:debugHost:installId:)` takes an
  `InstallIDMode`. `.perLaunch`, the default, keeps today's random id per
  launch. `.vendor` sends a SHA-256 hash of `identifierForVendor` and the
  site id as the install id, so an install keeps one id across launches
  without consent and without writing to the device. Batches under it carry
  `ctx.id: "vendor"` and the server counts the install for retention. With
  consent the Keychain id still wins. Declare Device ID in the privacy label
  if you use it.
- `FounderData.trackPurchase(product:source:_:)` sends `purchase_start`, runs
  your purchase closure (for example RevenueCat's
  `Purchases.shared.purchase(package:)`) and sends the goal for the
  `FounderData.PurchaseOutcome` it returns: `.purchased`, `.cancelled`,
  `.pending` or `.failed(reason)`. Errors it throws are reported and thrown
  again, with RevenueCat's cancel, pending and network codes sorted without
  a RevenueCat dependency.
- `PurchaseFailureReason(error)` sorts RevenueCat errors: `networkError` is
  `network`, the others `store`.
- `FounderData.purchase(_:source:options:)` buys a StoreKit 2 product and
  reports it. It adds `appAccountToken`, sends `purchase_start` and the
  outcome goal (`purchase_cancelled`, `purchase_pending` or `purchase_failed`
  with a `reason`), calls `track(purchase:)` and returns StoreKit's result
  unchanged.
- `FounderData.flush()` uploads the queue at once and returns how many events
  the server accepted.
- `configure` stops a Debug build at an `assertionFailure` when the site id is
  empty, the host is not a URL, or `host` or `debugHost` uses plain http
  outside `localhost`, `*.local` and private network addresses. Release builds
  log the same message as an error.
- Typed goal helpers for the names in `docs/APP-EVENTS.md`:
  `paywallViewed(source:paywall:)`, `purchaseStarted`, `purchaseCancelled`,
  `purchasePending`, `purchaseFailed(product:source:reason:)`,
  `restoreStarted`, `restoreSucceeded`, `onboardingSkipped(at:)`,
  `flowStarted()`, `flowExited(at:)`, `activation(_:)`,
  `permissionPrompted(_:)` and `permissionAnswered(_:result:)`.
- `FounderData.PaywallSource` (`.onboarding`, `.settings`, `.featureGate`,
  `.gate(_:)` or a string literal) and `FounderData.PurchaseFailureReason`,
  which sorts a StoreKit error into `network`, `store`, `verification` or
  `other`.
- `FounderData.reset()` for sign-out: a new install id and a new session, so the
  next user of the device is not linked to the one before.
- `FounderData.revenueCatAttributes`, the subscriber attribute
  `founderDataVisitorId` that links a RevenueCat purchase to the app session.
- `PrivacyInfo.xcprivacy`, shipped as a package resource: no tracking,
  Product Interaction, Purchase History and Coarse Location for Analytics,
  and UserDefaults with reason `CA92.1`.

### Docs

- "Using RevenueCat" buys with `trackPurchase`, a 7-line `buy` function
  instead of 21 lines.
- "Storage and consent" explains the `.vendor` mode and its privacy
  trade-off; the privacy label table has a column for it.
- The README starts with two setup paths, RevenueCat and StoreKit 2, three
  steps each.
- A privacy label table for App Store Connect, with a column for no consent,
  consent and `identify()`.
- Toolchain (Xcode 26, `swift-tools-version: 6.2`), pinning a commit, and the
  versioning policy.
