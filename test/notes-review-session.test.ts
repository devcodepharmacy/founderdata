// POST /api/sites/:id/notes/:nid/review: the change review behind the login, for the dashboard and the iPhone app.
// Same rules as POST /api/v1/notes/:id/review (test/agent-loop.test.ts), but with the admin cookie or a phone token.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startWorker, type TestWorker } from './helpers/worker';
import { itPro } from './helpers/edition';

describe('change review with the login', () => {
  let w: TestWorker;
  let site: any;
  let other: any;
  let token: string;

  const addNote = async (s: any, text: string) =>
    (await w.admin(`/api/sites/${s.id}/notes`, { method: 'POST', json: { text, ts: Date.now() - 3_600_000 } })).body;
  const review = (s: any, id: string, json: unknown, headers: Record<string, string> = {}) =>
    w.fetch(`/api/sites/${s.id}/notes/${id}/review`, { method: 'POST', json, headers });

  beforeAll(async () => {
    w = await startWorker();
    site = await w.createSite({ domain: 'shipkit.example.com' });
    other = await w.createSite({ domain: 'other.example.com' });
    const res = await w.fetch('/api/mobile/login', { method: 'POST', json: { password: 'test-password', deviceName: 'Review' }, headers: { cookie: '' } });
    ({ token } = (await res.json()) as any);
  });
  afterAll(() => w.dispose());

  it('marks a note reviewed once with the admin cookie, for 1 row', async () => {
    const note = await addNote(site, 'Launch thread on X');
    w.takeRowsWritten();
    const res = await review(site, note.id, { outcome: 'reverted', comment: 'Revenue per visitor fell' });
    expect(res.status).toBe(200);
    expect(w.takeRowsWritten()).toBe(1);
    const body = await res.json<any>();
    expect(body).toMatchObject({ ok: true, id: note.id, reviewed_now: true, note: { review: { outcome: 'reverted', comment: 'Revenue per visitor fell' } } });

    const again = await review(site, note.id, { outcome: 'kept' });
    expect(await again.json<any>()).toMatchObject({ reviewed_now: false, note: { review: { outcome: 'reverted' } } });

    // The dashboard's note list shows the outcome.
    const list = (await w.admin(`/api/sites/${site.id}/notes`)).body as any[];
    expect(list.find((n) => n.id === note.id)).toMatchObject({ review_outcome: 'reverted' });
  });

  itPro('takes a phone token, which may not make other writes', async () => {
    const note = await addNote(site, 'Pro plan from $79 to $99');
    const bearer = { cookie: '', authorization: `Bearer ${token}` };
    const res = await review(site, note.id, { outcome: 'kept' }, bearer);
    expect(res.status).toBe(200);
    expect(await res.json<any>()).toMatchObject({ reviewed_now: true, note: { review: { outcome: 'kept' } } });
    // The phone still can't change the site itself.
    expect((await w.fetch(`/api/sites/${site.id}`, { method: 'PATCH', json: { name: 'x' }, headers: bearer })).status).toBe(403);
  });

  it('refuses a wrong outcome, another site\'s note and no login', async () => {
    const note = await addNote(site, 'New hero headline');
    expect((await review(site, note.id, { outcome: 'undone' })).status).toBe(400);
    expect((await review(other, note.id, { outcome: 'kept' })).status).toBe(404);
    expect((await review(site, note.id, { outcome: 'kept' }, { cookie: '' })).status).toBe(401);
  });
});
