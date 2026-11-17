import type { Site } from '../../lib/api';
import { ProSlot } from '../ProSlot';
import { isPro } from '../../lib/pro';
import { Code } from '../Code';
import { Integration } from './Integration';
import { Note } from '../ui';
import { Mark, SettingRow, Step, Steps, Switch } from './kit';
import { SetupIcons } from './icons';
import type { Save } from './Payments';

/** App Store purchases and, in FounderData Pro, Apple Search Ads. The bundle id itself is under Site, General. */
export function AppStoreGroup({ site, origin, save }: { site: Site; origin: string; save: Save }) {
  return (
    <div className="space-y-4">
      <Integration
        id="app-store"
        site={site}
        mark={<Mark>{SetupIcons.appstore}</Mark>}
        title="App Store purchases"
        desc="Purchases the app reports, plus renewals and refunds from Apple."
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
        <Note tone="warn">
          Add the bundle id under{' '}
          <a className="font-medium underline underline-offset-2" href="#general">
            Site, General
          </a>{' '}
          first, or the server refuses the app's events.
        </Note>
      )}
      <Steps>
        <Step n={1} title="Report purchases from the app" done={!!site.app_bundle_id}>
          FounderDataKit reports each purchase. Setup is in the{' '}
          <a className="font-medium text-ink underline underline-offset-2" href="#ios-sdk">
            iOS app SDK
          </a>{' '}
          card.
        </Step>
        <Step n={2} title="Point App Store Server Notifications here">
          In App Store Connect, open <b>App Information, App Store Server Notifications</b>. Set this as the Production URL, Version 2, and as the Sandbox URL if you
          test purchases.
          <div className="mt-2">
            <Code>{`${origin}/api/webhooks/apple/${site.id}`}</Code>
          </div>
          <Note
            className="mt-3"
            more={
              <>
                <p>If your own backend already receives these notifications, have it forward the raw request body here.</p>
                <p>
                  Apple's notifications add renewals, refunds and purchases made on other devices. Amounts are what the customer paid, tax included, in their currency.
                  Apple's commission is not taken off, so the dashboard labels App Store revenue as gross.
                </p>
              </>
            }
          >
            Amounts are gross: what the customer paid, tax included.
          </Note>
        </Step>
      </Steps>
      <div className="divide-y divide-stone-200/60 border-t border-stone-200/60 pt-4">
        <SettingRow
          title="App Store commission"
          htmlFor="app-commission"
          help="Used for the After Apple's cut view."
          info="The Subscriptions tab and the Apple Search Ads card can switch to After Apple's cut. For a product in the App Store Connect sales import, Apple's own proceeds are used instead, which also take out VAT."
        >
          <select
            id="app-commission"
            className="input w-64"
            value={site.app_commission ?? 15}
            onChange={(e) => save({ app_commission: Number(e.target.value) }, `Commission set to ${e.target.value}%`)}
          >
            <option value={15}>15%, Small Business Program</option>
            <option value={30}>30%</option>
          </select>
        </SettingRow>
        <SettingRow
          title="Record sandbox purchases"
          help="From TestFlight and sandbox accounts. Never counted as revenue."
          info="They appear in Journey marked Sandbox. Turn this on while you test, then off."
        >
          <Switch checked={!!site.accept_sandbox} label="Record sandbox purchases" onChange={(v) => save({ accept_sandbox: v ? 1 : 0 }, v ? 'Sandbox purchases on' : 'Sandbox purchases off')} />
        </SettingRow>
      </div>
    </div>
  );
}
