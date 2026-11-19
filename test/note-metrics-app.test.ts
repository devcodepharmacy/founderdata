// An app's notes (src/worker/note-metrics.ts metricsFor): App Store downloads and trials that turn paid are allowed on
// every app note without a page, and become the defaults of a listing change and a release once the app has the data.
import { describe, expect, it } from 'vitest';
import { metricsFor, noteMetricOf, VERDICT_METRICS, windowFor, waitDays } from '../src/worker/note-metrics';

const app = { product_type: 'app', app_bundle_id: 'com.example.app' } as const;
const web = { product_type: 'saas', app_bundle_id: null } as const;

describe('app metrics', () => {
  it('defaults a release to trials that turn paid and a listing change to downloads only with the data', () => {
    expect(metricsFor('release', null, app)[0]).toBe('paywall_conversion');
    expect(metricsFor('release', null, app, { downloads: true, trials: true })[0]).toBe('trial_to_paid');
    expect(metricsFor('aso', null, app, { downloads: true, trials: false })[0]).toBe('app_downloads');
    expect(metricsFor('aso', null, app, { downloads: false, trials: true })[0]).toBe('visits');
    expect(metricsFor('pricing', null, app, { downloads: true, trials: true })[0]).toBe('paywall_conversion');
    expect(metricsFor('aso', null, app)).toContain('trial_to_paid');
    // A keyword change keeps its rank, and a web site never gets the app metrics.
    expect(metricsFor('aso', 'keyword:habit tracker', app, { downloads: true, trials: true })[0]).toBe('keyword_rank');
    expect(metricsFor('release', null, web, { downloads: true, trials: true })).not.toContain('app_downloads');
  });

  it('names every verdict metric and the note metric that judges it', () => {
    expect(VERDICT_METRICS).toContain('app_downloads');
    expect(VERDICT_METRICS).not.toContain('visits');
    expect(['revenue_per_visitor', 'conversion_rate', 'visitors'].map(noteMetricOf)).toEqual(['visits', 'visits', 'visits']);
    expect(noteMetricOf('search_position')).toBe('search_clicks');
    expect(noteMetricOf('trials_30d')).toBeNull();
    expect([windowFor('trial_to_paid'), windowFor('app_downloads'), waitDays('app_downloads'), waitDays('trial_to_paid')]).toEqual([14, 7, 3, 1]);
  });
});
