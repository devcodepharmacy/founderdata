import type { Site } from '../../lib/api';
import { ProSlot } from '../ProSlot';
import { isPro } from '../../lib/pro';
import { Code } from '../Code';
import { Integration } from './Integration';
import { Callout, Mark, Step, Steps } from './kit';
import { SetupIcons } from './icons';
import type { Save } from './Payments';

/** App Store purchases and, in FounderData Pro, Apple Search Ads. The bundle id itself is under Site, General. */
export function AppStoreGroup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <div className="space-y-3">
      <Integration
        id="app-store"
        site={site}
        mark={<Mark>{SetupIcons.appstore}</Mark>}
        title="App Store purchases"
        desc="Purchases the app reports, plus renewals and refunds from Apple's notifications."
      >
        <AppStoreSetup site={site} origin={origin} save={save} />
      </Integration>
      {isPro && site.app_bundle_id && (
        <Integration id="apple-search-ads" site={site} mark={<Mark>ASA</Mark>} title="Apple Search Ads" desc="Spend, installs and ROAS per campaign and keyword, imported daily.">
          <div className="text-sm">
            <ProSlot name="asaStatus" />
          </div>
        </Integration>
      )}
    </div>
  );
}

function AppStoreSetup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <div className="space-y-5 text-sm">
      {!site.app_bundle_id && (
        <Callout tone="warn">
          Add the app's bundle id under <a className="font-medium underline underline-offset-2" href="#general">Site, General</a> first. Until then the server
          refuses the app's events and Apple's notifications.
        </Callout>
      )}
      <Steps>
        <Step n={1} title="Report purchases from the app" done={!!site.app_bundle_id}>
          FounderDataKit reports each purchase from the app. The <a className="font-medium text-ink underline underline-offset-2" href="#ios-sdk">iOS app SDK</a> card
          has the setup.
        </Step>
        <Step n={2} title="Point App Store Server Notifications here">
          In App Store Connect, open the app, then <b>App Information, App Store Server Notifications</b>. Set this as the Production URL with Version 2. Use it
          for Sandbox too if you test purchases. If your own backend already receives these notifications, have it forward the raw request body here.
          <div className="mt-2">
            <Code>{`${origin}/api/webhooks/apple/${site.id}`}</Code>
          </div>
          <p className="mt-2 text-stone-500">
            Apple's notifications add renewals, refunds and purchases made on other devices. Amounts are what the customer paid, tax included, in their
            currency. Apple's commission is not taken off, so the dashboard labels App Store revenue as gross.
          </p>
        </Step>
      </Steps>
      <div className="grid gap-4 border-t border-stone-200/60 pt-4 sm:grid-cols-2">
        <div>
          <label className="label" htmlFor="app-commission">
            App Store commission
          </label>
          <select
            id="app-commission"
            className="input"
            value={site.app_commission ?? 15}
            onChange={(e) => save({ app_commission: Number(e.target.value) }, `Commission set to ${e.target.value}%`)}
          >
            <option value={15}>15%, App Store Small Business Program</option>
            <option value={30}>30%</option>
          </select>
          <p className="mt-1.5 text-xs text-stone-500">
            Used when you switch the Subscriptions tab or the Apple Search Ads card to After Apple's cut. For a product in the App Store Connect sales import,
            Apple's own proceeds are used instead, which also take out VAT.
          </p>
        </div>
        <label className="flex items-start gap-2.5 sm:pt-6">
          <input
            type="checkbox"
            className="mt-1"
            checked={!!site.accept_sandbox}
            onChange={(e) => save({ accept_sandbox: e.target.checked ? 1 : 0 }, e.target.checked ? 'Sandbox purchases on' : 'Sandbox purchases off')}
          />
          <span>
            <span className="font-medium text-ink">Record sandbox purchases</span>
            <span className="mt-0.5 block text-xs text-stone-500">
              From TestFlight and sandbox accounts. They appear in Journey marked Sandbox and never count as revenue. Turn this on while you test, then off.
            </span>
          </span>
        </label>
      </div>
    </div>
  );
}
