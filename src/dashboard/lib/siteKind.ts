import type { Site } from './api';

/** An iOS app without a website: POST /api/sites gives it a placeholder domain under .invalid, never shown. */
export const isAppOnly = (site: Pick<Site, 'domain'>) => site.domain.endsWith('.invalid');

/** The site tracks a real website. */
export const hasWebsite = (site: Pick<Site, 'domain'>) => !isAppOnly(site);

/** A bundle id like com.example.app: letters, digits and hyphens, in two or more parts split by dots. */
export const BUNDLE_ID = /^[A-Za-z0-9][A-Za-z0-9-]*(\.[A-Za-z0-9-]+)+$/;

/** The Swift that starts FounderDataKit in an app (ios/README.md). */
export const swiftSetup = (siteId: string, origin: string) => `import FounderDataKit

@main struct MyApp: App {
    init() {
        FounderData.configure(siteId: "${siteId}", host: "${origin}")
        FounderData.observeTransactions()
    }
    var body: some Scene {
        WindowGroup { RootView().onOpenURL { FounderData.handle(url: $0) } }
    }
}`;
