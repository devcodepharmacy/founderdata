// One subrequest budget for a whole scheduled invocation (README "What it costs", docs/ASO.md "What fits the free plan").
//
// Workers Free allows 50 subrequests per invocation, and a D1 query counts as one (a batch counts once). Everything the
// cron starts in one invocation draws on that single pool, so the jobs share one counter instead of each keeping its own
// cap. `scheduled()` makes one SubrequestBudget, wraps the D1 binding and the fetch it hands to the jobs with it, and runs
// the jobs one after another. The wrappers count every call, so a job needs no bookkeeping of its own; it only asks
// `can(n)` before it starts something that needs n more calls, and stops cleanly when the answer is no.
//
// A paid call (DataForSEO task_post, an AI engine call, an X read) must only start when `can` also covers the D1 writes
// that record it. A call that is paid for and then not recorded would be paid for twice or lost.
//
// The wrappers are the safety net: a call past the hard limit throws BudgetExhausted instead of reaching Cloudflare, which
// would throw "Too many subrequests" anyway.
import type { Env } from './env';

/** What a Workers Free invocation may make. */
export const FREE_SUBREQUESTS = 50;
/** Left unspent on purpose: a job that miscounts by a call or two still finishes inside the 50. */
export const RESERVE = 2;

export class BudgetExhausted extends Error {
  constructor() {
    super('Out of subrequests for this invocation');
  }
}

export class SubrequestBudget {
  /** Calls made so far, D1 queries and fetches together. */
  used = 0;
  constructor(readonly limit = FREE_SUBREQUESTS - RESERVE) {}

  get left() {
    return Math.max(0, this.limit - this.used);
  }
  /** True when `n` more calls fit. */
  can(n = 1) {
    return this.left >= n;
  }
  /** Counts `n` calls made outside the wrappers. Throws BudgetExhausted when they do not fit. */
  spend(n = 1) {
    if (!this.can(n)) throw new BudgetExhausted();
    this.used += n;
  }

  /** A fetch that counts each call. */
  fetch<F extends (...a: any[]) => Promise<Response>>(f: F): F {
    return (async (...a: Parameters<F>) => {
      this.spend(1);
      return f(...a);
    }) as F;
  }

  /** The env with a D1 binding that counts each query and each batch. */
  env<E extends Pick<Env, 'DB'>>(env: E): E {
    return { ...env, DB: meterDb(env.DB, this) };
  }
}

const UNWRAP = Symbol('unwrapStatement');

function meterStatement(st: D1PreparedStatement, b: SubrequestBudget): D1PreparedStatement {
  const wrapped: any = {
    [UNWRAP]: st,
    bind: (...a: unknown[]) => meterStatement(st.bind(...a), b),
    // Async, so a refused call is a rejected promise like any other failed query, and `.catch()` on it works.
    run: async (...a: any[]) => (b.spend(), (st.run as any)(...a)),
    all: async (...a: any[]) => (b.spend(), (st.all as any)(...a)),
    first: async (...a: any[]) => (b.spend(), (st.first as any)(...a)),
    raw: async (...a: any[]) => (b.spend(), (st.raw as any)(...a)),
  };
  return wrapped;
}

function meterDb(db: D1Database, b: SubrequestBudget): D1Database {
  return {
    prepare: (sql: string) => meterStatement(db.prepare(sql), b),
    batch: async (stmts: D1PreparedStatement[]) => (b.spend(), db.batch(stmts.map((s) => (s as any)[UNWRAP] ?? s))),
    exec: async (sql: string) => (b.spend(), db.exec(sql)),
    withSession: (...a: any[]) => (db as any).withSession(...a),
    dump: () => db.dump(),
  } as unknown as D1Database;
}

/** The calls a job needs before it may start a paid call: the call itself plus the D1 statements that record it. */
export const PAID_CALL = (writes: number) => 1 + writes;
