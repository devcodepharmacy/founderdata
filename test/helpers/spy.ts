// An Env whose D1 binding counts queries and rows read, the way a Free invocation's 50-subrequest limit does.
import type { Env } from '../../src/worker/env';

/** An Env whose D1 binding counts queries, the way a Free invocation's 50-query limit does. */
export function spied(env: Env, n: { q: number; read: number }): Env {
  const db = env.DB as any;
  const tally = (r: any) => ((n.read += r.meta?.rows_read ?? 0), r);
  const wrap = (st: any): any => ({
    __st: st,
    bind: (...a: unknown[]) => wrap(st.bind(...a)),
    first: async (col?: string) => {
      n.q++;
      const r = await st.all();
      n.read += r.meta?.rows_read ?? 0;
      const row = r.results[0] ?? null;
      return col ? (row ? row[col] : null) : row;
    },
    all: async () => (n.q++, tally(await st.all())),
    run: async () => (n.q++, tally(await st.run())),
    raw: (...a: unknown[]) => (n.q++, st.raw(...a)),
  });
  return { ...env, DB: { prepare: (sql: string) => wrap(db.prepare(sql)), batch: async (s: any[]) => (n.q++, (await db.batch(s.map((x) => x.__st ?? x))).map(tally)), exec: (sql: string) => db.exec(sql) } } as unknown as Env;
}
