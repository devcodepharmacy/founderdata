import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { navigate } from '../App';
import { api, type Site } from '../lib/api';
import { BUNDLE_ID } from '../lib/siteKind';
import { Modal } from './Modal';
import { TypeSetup } from './ProductType';
import { SetupIcons } from './setup/icons';
import { AiPromptPanel, FirstData, SdkSteps, TrackerSnippet } from './setup/Install';
import { InlineError, Step, Steps } from './setup/kit';
import { Spinner } from './ui';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'INR', 'CAD', 'AUD', 'SGD', 'JPY', 'BRL'];

/** What is being added. A website can also be a browser extension or a newsletter (components/ProductType.tsx). */
type Kind = 'website' | 'app' | 'both' | 'extension' | 'newsletter';
const KINDS: { value: Kind; label: string; text: string; icon: ReactNode }[] = [
  { value: 'website', label: 'Website', text: 'One script tag. Visitors, sources, pages and revenue per source.', icon: SetupIcons.site },
  { value: 'app', label: 'iOS app', text: 'A Swift package. Sessions, screens, onboarding and App Store purchases.', icon: SetupIcons.phone },
  { value: 'both', label: 'Website and iOS app', text: 'One site with both, split by platform.', icon: SetupIcons.install },
  { value: 'extension', label: 'Browser extension', text: 'Installs, weekly active and uninstalls, from a few lines in the extension.', icon: SetupIcons.puzzle },
  { value: 'newsletter', label: 'Newsletter', text: 'Subscribers, unsubscribes and opens, from your newsletter tool.', icon: SetupIcons.mail },
];

type StepId = 'kind' | 'details' | 'install';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'kind', label: 'What it is' },
  { id: 'details', label: 'Details' },
  { id: 'install', label: 'Install' },
];

/** A short guided flow: pick what it is, give its domain or bundle id, then install it and watch the first visit arrive. */
export function AddSite({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState<StepId>('kind');
  const [kind, setKind] = useState<Kind>('website');
  const [domain, setDomain] = useState('');
  const [bundle, setBundle] = useState('');
  const [name, setName] = useState('');
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
  const [currency, setCurrency] = useState('USD');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<Site | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);
  const ids = { domain: useId(), bundle: useId(), name: useId(), tz: useId(), cur: useId() };

  const web = kind !== 'app';
  const app = kind === 'app' || kind === 'both';
  const bundleBad = app && bundle.trim() !== '' && !BUNDLE_ID.test(bundle.trim());
  const ready = (!web || domain.trim() !== '') && (!app || (bundle.trim() !== '' && !bundleBad));

  // Focus the new step's heading, so a keyboard or screen reader starts at its top.
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
  }, [step]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const json = {
        name,
        timezone,
        currency,
        ...(web ? { domain } : {}),
        ...(app ? { app_bundle_id: bundle.trim() } : {}),
        ...(kind === 'extension' || kind === 'newsletter' ? { type: kind } : {}),
      };
      setAdded(await api<Site>('/api/sites', { method: 'POST', json }));
      setStep('install');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Closing after a site was added opens its dashboard, so the new site is never out of sight.
  const close = () => {
    if (added) navigate(`/site/${added.id}`);
    else onClose();
  };

  const at = STEPS.findIndex((s) => s.id === step);
  const title = step === 'kind' ? 'What are you adding?' : step === 'details' ? `Add a ${KINDS.find((k) => k.value === kind)!.label.toLowerCase()}` : `Install ${added?.name ?? ''}`;

  return (
    <Modal open={open} onClose={close} title="Add a website or app" width="max-w-2xl">
      <ol className="mb-5 flex items-center gap-2 text-xs font-medium" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className="flex min-w-0 flex-1 items-center gap-2" aria-current={i === at ? 'step' : undefined}>
            <span
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] ring-1 ring-inset transition-colors duration-base ${
                i < at ? 'bg-emerald-500 text-[#fff] ring-emerald-500' : i === at ? 'bg-ink text-white ring-ink' : 'bg-stone-50 text-stone-400 ring-stone-200'
              }`}
              aria-hidden="true"
            >
              {i < at ? '✓' : i + 1}
            </span>
            <span className={`truncate ${i === at ? 'text-ink' : 'text-stone-400'}`}>{s.label}</span>
            {i < STEPS.length - 1 && <span className="h-px min-w-3 flex-1 bg-stone-200" aria-hidden="true" />}
          </li>
        ))}
      </ol>

      <h3 ref={heading} tabIndex={-1} className="text-title text-ink outline-none">
        {title}
      </h3>

      {step === 'kind' && (
        <div className="mt-4">
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="What are you adding?">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                role="radio"
                aria-checked={kind === k.value}
                className={`flex items-start gap-3 rounded-xl border bg-white p-3.5 text-left transition-[border-color,box-shadow,transform] duration-fast active:scale-[0.99] ${
                  kind === k.value ? 'border-focus/60 ring-[3px] ring-focus/15' : 'border-stone-200/80 hover:border-stone-300'
                } ${k.value === 'both' ? 'sm:col-span-2' : ''}`}
                onClick={() => setKind(k.value)}
                onDoubleClick={() => (setKind(k.value), setStep('details'))}
              >
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-stone-50 text-stone-600 ring-1 ring-inset ring-stone-200/80">{k.icon}</span>
                <span className="min-w-0">
                  <span className="block text-sm font-semibold text-ink">{k.label}</span>
                  <span className="mt-0.5 block text-[13px] text-stone-500">{k.text}</span>
                </span>
              </button>
            ))}
          </div>
          <div className="mt-5 flex justify-end">
            <button className="btn-dark" onClick={() => setStep('details')}>
              Continue
            </button>
          </div>
        </div>
      )}

      {step === 'details' && (
        <form onSubmit={submit} className="mt-4 space-y-4">
          {web && (
            <div>
              <label className="label" htmlFor={ids.domain}>
                {kind === 'website' || kind === 'both' ? 'Domain' : kind === 'extension' ? "The extension's website" : "The newsletter's website"}
              </label>
              <input id={ids.domain} className="input" placeholder="example.com" value={domain} onChange={(e) => setDomain(e.target.value)} autoFocus autoCapitalize="off" spellCheck={false} />
              <p className="mt-1.5 text-xs text-stone-500">
                {kind === 'extension' || kind === 'newsletter' ? 'Events name a page on this domain.' : 'Subdomains such as app.example.com count as the same site.'}
              </p>
            </div>
          )}
          {app && (
            <div>
              <label className="label" htmlFor={ids.bundle}>
                Bundle id
              </label>
              <input
                id={ids.bundle}
                className="input font-mono"
                placeholder="com.example.app"
                value={bundle}
                onChange={(e) => setBundle(e.target.value)}
                autoFocus={!web}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                aria-invalid={bundleBad || undefined}
              />
              <p className={`mt-1.5 text-xs ${bundleBad ? 'text-red-600' : 'text-stone-500'}`}>
                {bundleBad
                  ? 'A bundle id has letters, digits and hyphens in two or more parts split by dots, like com.example.app.'
                  : 'In Xcode: the app target, General, Bundle Identifier. The server takes events only from this app.'}
              </p>
            </div>
          )}
          <div>
            <label className="label" htmlFor={ids.name}>
              Name
            </label>
            <input id={ids.name} className="input" placeholder={app && !web ? 'My app' : domain.trim() || 'My SaaS'} value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor={ids.tz}>
                Timezone
              </label>
              <input id={ids.tz} className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </div>
            <div>
              <label className="label" htmlFor={ids.cur}>
                Revenue currency
              </label>
              <select id={ids.cur} className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {CURRENCIES.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
            </div>
          </div>
          {error && <InlineError message={error} />}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button type="button" className="btn-ghost" onClick={() => setStep('kind')}>
              Back
            </button>
            <button className="btn-dark" disabled={!ready || busy}>
              {busy ? (
                <>
                  <Spinner /> Adding
                </>
              ) : (
                'Add and get the install code'
              )}
            </button>
          </div>
        </form>
      )}

      {step === 'install' && added && (
        <div className="mt-4 space-y-5 text-sm">
          <InstallSteps site={added} kind={kind} />
          <AiPromptPanel site={added} origin={window.location.origin} />
          <FirstData site={added} />
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-stone-200/60 pt-4">
            <p className="text-[13px] text-stone-500">Payments, Search Console and agents are in Settings when you want them.</p>
            <div className="flex gap-2">
              <button className="btn" onClick={() => navigate(`/site/${added.id}/settings#payments`)}>
                Connect payments
              </button>
              <button className="btn-dark" onClick={() => navigate(`/site/${added.id}`)}>
                Open dashboard
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/** The script tag, the Swift setup, or the extension or newsletter events, each with a copy button. */
function InstallSteps({ site, kind }: { site: Site; kind: Kind }) {
  const origin = window.location.origin;
  if (kind === 'extension' || kind === 'newsletter') return <TypeSetup site={site} type={kind} origin={origin} />;
  return (
    <Steps>
      {kind !== 'app' && (
        <Step n={1} title={`Paste this in the <head> of every page on ${site.domain}`}>
          <div className="mt-2">
            <TrackerSnippet site={site} origin={origin} />
          </div>
        </Step>
      )}
      {kind !== 'website' && <SdkSteps site={site} origin={origin} start={kind === 'app' ? 1 : 2} />}
    </Steps>
  );
}
