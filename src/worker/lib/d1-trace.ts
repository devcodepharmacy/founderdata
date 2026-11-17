// Counts the D1 calls of one request, for the Server-Timing header (index.ts) and the round-trip tests.
//
// Each call is a network round trip to the database: a statement's run, all, first or raw, a batch, an exec. `calls`
// counts them all; `depth` counts the ones the request waited for one after another, which is what latency follows when
// the Worker is far from the database. A call's depth is 1 more than the deepest call that had finished when it
// started, so calls started together share a depth, and a call started after awaiting another sits one level below it.
//
// The wrapper is per request. Code that keeps a per-isolate cache keyed on the D1 binding (fx.ts, alerts.ts) looks
// through it with rawDb, so a traced request still hits the same cache entries as an untraced one.

export interface D1Trace {
  calls: number;
  depth: number;
  /** The deepest depth among finished calls; a new call starts one level below it. */
  done: number;
  /** D1's own time for the statements (meta.duration, ms), summed: the SQL, without the network. */
  sqlMs: number;
  /** Rows the statements read (meta.rows_read), summed. */
  rowsRead: number;
}

export const newTrace = (): D1Trace => ({ calls: 0, depth: 0, done: 0, sqlMs: 0, rowsRead: 0 });

/** Adds a result's meta (one D1Result, or a batch's list) to the trace. A `first` row carries no meta and adds nothing. */
function addMeta(t: D1Trace, r: unknown) {
  for (const x of Array.isArray(r) ? r : [r]) {
    const meta = (x as { meta?: { duration?: number; rows_read?: number } } | null)?.meta;
    if (!meta) continue;
    t.sqlMs += Number(meta.duration ?? 0);
    t.rowsRead += Number(meta.rows_read ?? 0);
  }
}

const RAW = Symbol('rawD1');
const UNWRAP = Symbol('unwrapStatement');

/** The binding underneath a traced one (or the binding itself). Use it as the key of a per-isolate cache. */
export const rawDb = (db: D1Database): D1Database => ((db as any)?.[RAW] as D1Database | undefined) ?? db;

async function timed<T>(t: D1Trace, call: () => Promise<T>): Promise<T> {
  const level = t.done + 1;
  t.calls++;
  t.depth = Math.max(t.depth, level);
  try {
    const r = await call();
    addMeta(t, r);
    return r;
  } finally {
    t.done = Math.max(t.done, level);
  }
}

function traceStatement(st: D1PreparedStatement, t: D1Trace): D1PreparedStatement {
  return {
    [UNWRAP]: st,
    bind: (...a: unknown[]) => traceStatement(st.bind(...a), t),
    run: (...a: any[]) => timed(t, () => (st.run as any)(...a)),
    all: (...a: any[]) => timed(t, () => (st.all as any)(...a)),
    first: (...a: any[]) => timed(t, () => (st.first as any)(...a)),
    raw: (...a: any[]) => timed(t, () => (st.raw as any)(...a)),
  } as unknown as D1PreparedStatement;
}

/** A D1 binding that counts each call into `t`. Statements from it can go into its own batch. */
export function traceDb(db: D1Database, t: D1Trace): D1Database {
  const raw = rawDb(db);
  return {
    [RAW]: raw,
    prepare: (sql: string) => traceStatement(db.prepare(sql), t),
    batch: (stmts: D1PreparedStatement[]) => timed(t, () => db.batch(stmts.map((s) => (s as any)[UNWRAP] ?? s))),
    exec: (sql: string) => timed(t, () => db.exec(sql)),
    withSession: (...a: any[]) => (db as any).withSession(...a),
    dump: () => (db as any).dump(),
  } as unknown as D1Database;
}

// ---------- one batch per wait

interface Pending {
  stmts: D1PreparedStatement[];
  resolve: (r: D1Result[]) => void;
  reject: (e: unknown) => void;
}

/**
 * A D1 binding that sends the reads a request starts together as one batch. Every `all` and `first`, and every
 * `batch`, made before the request next waits (a zero timer, so all pending promise callbacks run first) leaves in one
 * `db.batch`, one round trip, and each caller gets its own results. Code keeps its shape: two helpers started with
 * Promise.all cost one round trip instead of two parallel ones. A failed combined batch is retried one caller at a
 * time, so one bad statement fails only its own caller, as before. `run` and `raw` go straight through: a write
 * keeps its own transaction, and raw rows need the statement's own call.
 */
export function batchingDb(db: D1Database): D1Database {
  const raw = rawDb(db);
  let queue: Pending[] = [];
  let scheduled = false;
  const flush = async () => {
    scheduled = false;
    const list = queue;
    queue = [];
    if (list.length === 1) {
      const p = list[0];
      return db.batch(p.stmts).then(p.resolve, p.reject);
    }
    let results: D1Result[];
    try {
      results = await db.batch(list.flatMap((p) => p.stmts));
    } catch {
      for (const p of list) db.batch(p.stmts).then(p.resolve, p.reject);
      return;
    }
    let at = 0;
    for (const p of list) {
      p.resolve(results.slice(at, at + p.stmts.length));
      at += p.stmts.length;
    }
  };
  const enqueue = (stmts: D1PreparedStatement[]) =>
    new Promise<D1Result[]>((resolve, reject) => {
      queue.push({ stmts, resolve, reject });
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    });
  const statement = (st: D1PreparedStatement): D1PreparedStatement =>
    ({
      [UNWRAP]: st,
      bind: (...a: unknown[]) => statement(st.bind(...a)),
      all: () => enqueue([st]).then((r) => r[0]),
      first: (col?: string) =>
        enqueue([st]).then((r) => {
          const row = (r[0].results?.[0] as Record<string, unknown> | undefined) ?? null;
          return col === undefined ? row : row && col in row ? row[col] : null;
        }),
      run: (...a: any[]) => (st.run as any)(...a),
      raw: (...a: any[]) => (st.raw as any)(...a),
    }) as unknown as D1PreparedStatement;
  return {
    [RAW]: raw,
    prepare: (sql: string) => statement(db.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => (stmts.length ? enqueue(stmts.map((s) => (s as any)[UNWRAP] ?? s)) : Promise.resolve([])),
    exec: (sql: string) => db.exec(sql),
    withSession: (...a: any[]) => (db as any).withSession(...a),
    dump: () => (db as any).dump(),
  } as unknown as D1Database;
}
