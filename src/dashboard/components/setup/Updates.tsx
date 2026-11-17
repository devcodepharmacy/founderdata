import { useState } from 'react';
import { RELEASE_URL, VERSION } from '../../../shared/product';
import { updatePrompt } from '../../../shared/pro-prompts';
import { isPro } from '../../lib/pro';
import { newerRelease, parseRelease } from '../../lib/updates';
import { PRO_LIST } from '../../lib/proFeatures';
import { Code } from '../Code';
import { ProActions } from '../ProUpsell';
import { SettingsCard } from './kit';

type Check = { state: 'idle' } | { state: 'busy' } | { state: 'latest' } | { state: 'newer'; version: string; date: string; notes?: string } | { state: 'error'; message: string };

/**
 * Settings, Updates: this build's version and edition, and a check against the latest release. The browser fetches
 * RELEASE_URL on click only, so a deployment never calls out by itself. The prompt hands the update to the owner's agent.
 */
export function UpdatesCard() {
  const edition = isPro ? 'pro' : 'core';
  const [check, setCheck] = useState<Check>({ state: 'idle' });

  async function run() {
    setCheck({ state: 'busy' });
    try {
      const res = await fetch(RELEASE_URL, { cache: 'no-store' });
      if (!res.ok) throw new Error(`The release file answered ${res.status}.`);
      const release = parseRelease(await res.text());
      if (!release) throw new Error('The release file is not valid JSON with a version.');
      const newer = newerRelease(VERSION, release);
      setCheck(newer ? { state: 'newer', version: newer.version, date: newer.date, notes: newer.notes } : { state: 'latest' });
    } catch (e) {
      setCheck({ state: 'error', message: e instanceof TypeError ? 'Could not reach the release file. Check your connection and try again.' : (e as Error).message });
    }
  }

  return (
    <SettingsCard
      id="updates"
      title="Updates"
      desc={`You run FounderData ${isPro ? 'Pro' : 'core'} ${VERSION}. The check reads the latest release from GitHub when you click.`}
      actions={
        <button className="btn" onClick={run} disabled={check.state === 'busy'}>
          {check.state === 'busy' ? 'Checking' : 'Check for updates'}
        </button>
      }
    >
      <div className="space-y-4 text-sm">
        <div aria-live="polite">
          {check.state === 'idle' && <p className="text-stone-500">Not checked yet.</p>}
          {check.state === 'latest' && <p className="text-stone-600">You run the latest release, {VERSION}.</p>}
          {check.state === 'error' && <p className="text-red-700">{check.message}</p>}
          {check.state === 'newer' && (
            <div>
              <p className="font-medium text-ink">
                Version {check.version} is out{check.date ? `, released ${check.date}` : ''}. You run {VERSION}.
              </p>
              {check.notes && <p className="mt-1 whitespace-pre-line text-stone-600">{check.notes}</p>}
            </div>
          )}
        </div>
        <div>
          <p className="mb-2 text-[13px] text-stone-500">Paste this into the AI agent that manages this deployment. It merges the release, resolves conflicts with your changes and deploys.</p>
          <Code>{updatePrompt(edition, check.state === 'newer' ? check.version : undefined)}</Code>
        </div>
      </div>
    </SettingsCard>
  );
}

/** Settings, FounderData Pro: what Pro adds and how to get it. Core builds only. */
export function ProCard() {
  return (
    <SettingsCard
      id="pro"
      title="FounderData Pro"
      desc="One payment, every future update included. Pro runs on your own Cloudflare account like core, and your data stays there."
    >
      <ul className="list-disc space-y-1 pl-5 text-[13px] text-stone-600">
        {PRO_LIST.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <ProActions />
    </SettingsCard>
  );
}
