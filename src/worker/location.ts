import type { Env } from './env';
import { RETENTION_DAYS, RETENTION_MONTHS, retentionOf } from './retention';

// Where the deployment's data lives (docs/PRIVACY.md, "Keep the database in the EU"). The Worker can't ask D1 for its
// jurisdiction, so `npm run setup -- --jurisdiction eu` writes DATA_JURISDICTION into wrangler.local.jsonc. Unset or
// unknown means "not pinned": Cloudflare placed the database near where it was created.

export type Jurisdiction = 'eu' | 'fedramp';

export interface DataLocation {
  /** The D1 jurisdiction, or null when the database isn't pinned (or nobody told the Worker). */
  jurisdiction: Jurisdiction | null;
  /** Where the tables are stored, in one line. */
  stored: string;
  /** Where requests are handled, in one line. */
  processed: string;
  /** Days the daily cron keeps visits, events and subscription signals (RETENTION_MONTHS, docs/PRIVACY.md). */
  retention_days: number;
  /** Days after which names, emails and user ids are cleared (PII_RETENTION_MONTHS), or null when they are kept. */
  pii_retention_days: number | null;
}

/** RETENTION_MONTHS in days, the way pruneOldData cuts: 24 months is 730 days, any other month 30.44 days. */
const inDays = (months: number) => (months === RETENTION_MONTHS ? RETENTION_DAYS : Math.round(months * 30.44));

const STORED: Record<Jurisdiction, string> = {
  eu: 'EU (D1 jurisdiction eu)',
  fedramp: 'FedRAMP (D1 jurisdiction fedramp)',
};

export function dataLocation(env: Pick<Env, 'DATA_JURISDICTION' | 'RETENTION_MONTHS' | 'PII_RETENTION_MONTHS'>): DataLocation {
  const raw = (env.DATA_JURISDICTION ?? '').trim().toLowerCase();
  const jurisdiction = raw === 'eu' || raw === 'fedramp' ? raw : null;
  return {
    jurisdiction,
    stored: jurisdiction ? STORED[jurisdiction] : 'Not pinned to a region',
    processed:
      'The Worker handles each request in the Cloudflare data center nearest the visitor, which can be outside the EU. It hashes the IP address and user agent in memory and never stores them.',
    ...retentionDays(env),
  };
}

function retentionDays(env: Pick<Env, 'RETENTION_MONTHS' | 'PII_RETENTION_MONTHS'>) {
  const r = retentionOf(env);
  return { retention_days: inDays(r.months ?? RETENTION_MONTHS), pii_retention_days: r.piiMonths ? Math.round(r.piiMonths * 30.44) : null };
}
