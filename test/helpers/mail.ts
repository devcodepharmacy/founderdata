// In-memory stand-ins for the mail bindings (FounderData Pro mail, migration 0070): an R2 bucket, a queue that can drain
// into the Worker's queue() export, and a send_email binding that records what it sent and can fail with a coded
// error the way Cloudflare's does (pro/docs/mail-spike.md). Pass them to startWorker({ EMAIL, MAIL_BUCKET, MAIL_QUEUE }).
// Nothing leaves the machine.

const enc = new TextEncoder();

function bytesOf(value: unknown): Uint8Array {
  if (value == null) return new Uint8Array();
  if (typeof value === 'string') return enc.encode(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  throw new Error('FakeR2: pass a string, ArrayBuffer, typed array or stream');
}

async function readAll(value: unknown): Promise<Uint8Array> {
  if (value instanceof ReadableStream) return new Uint8Array(await new Response(value).arrayBuffer());
  if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
  return bytesOf(value);
}

interface Stored {
  bytes: Uint8Array;
  httpMetadata: R2HTTPMetadata;
  customMetadata: Record<string, string>;
  uploaded: Date;
}

function objectOf(key: string, s: Stored, body: boolean) {
  const base = {
    key,
    version: '1',
    size: s.bytes.byteLength,
    etag: `etag-${key}`,
    httpEtag: `"etag-${key}"`,
    uploaded: s.uploaded,
    httpMetadata: s.httpMetadata,
    customMetadata: s.customMetadata,
    checksums: {},
    storageClass: 'Standard',
    writeHttpMetadata(h: Headers) {
      if (s.httpMetadata.contentType) h.set('content-type', s.httpMetadata.contentType);
      if (s.httpMetadata.contentDisposition) h.set('content-disposition', s.httpMetadata.contentDisposition);
    },
  };
  if (!body) return base;
  const copy = () => s.bytes.slice();
  return {
    ...base,
    get body() {
      return new Response(copy()).body!;
    },
    bodyUsed: false,
    arrayBuffer: async () => copy().buffer,
    bytes: async () => copy(),
    text: async () => new TextDecoder().decode(s.bytes),
    json: async () => JSON.parse(new TextDecoder().decode(s.bytes)),
    blob: async () => new Blob([copy()]),
  };
}

/** An R2 bucket in memory: put, get, head, delete and list (prefix, limit, cursor). */
export class FakeR2 {
  readonly objects = new Map<string, Stored>();

  async put(key: string, value: unknown, opts: R2PutOptions = {}) {
    const stored: Stored = {
      bytes: await readAll(value),
      httpMetadata: (opts.httpMetadata as R2HTTPMetadata) ?? {},
      customMetadata: opts.customMetadata ?? {},
      uploaded: new Date(),
    };
    this.objects.set(key, stored);
    return objectOf(key, stored, false) as unknown as R2Object;
  }

  async get(key: string): Promise<R2ObjectBody | null> {
    const s = this.objects.get(key);
    return s ? (objectOf(key, s, true) as unknown as R2ObjectBody) : null;
  }

  async head(key: string): Promise<R2Object | null> {
    const s = this.objects.get(key);
    return s ? (objectOf(key, s, false) as unknown as R2Object) : null;
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.objects.delete(k);
  }

  async list(opts: R2ListOptions = {}) {
    const limit = Math.min(opts.limit ?? 1000, 1000);
    const all = [...this.objects.keys()].filter((k) => !opts.prefix || k.startsWith(opts.prefix)).sort();
    const from = opts.cursor ? Number(opts.cursor) : 0;
    const page = all.slice(from, from + limit);
    const truncated = from + limit < all.length;
    return {
      objects: page.map((k) => objectOf(k, this.objects.get(k)!, false) as unknown as R2Object),
      truncated,
      ...(truncated ? { cursor: String(from + limit) } : {}),
      delimitedPrefixes: [] as string[],
    };
  }

  /** The text of a stored object, or undefined. */
  text(key: string): string | undefined {
    const s = this.objects.get(key);
    return s ? new TextDecoder().decode(s.bytes) : undefined;
  }

  asBinding(): R2Bucket {
    return this as unknown as R2Bucket;
  }
}

/** One message a FakeQueue holds. */
export interface QueuedMessage {
  id: string;
  body: unknown;
  attempts: number;
  delaySeconds?: number;
}

/** What one drain() did. */
export interface DrainResult {
  batches: number;
  acked: number;
  retried: number;
  /** Messages still queued because they kept asking for a retry past `maxRounds`. */
  left: number;
}

type QueueHandler = (batch: MessageBatch<unknown>) => Promise<void>;

let seq = 0;

/** A queue producer that records every send and can hand the messages to the Worker's queue() export. */
export class FakeQueue {
  readonly sent: QueuedMessage[] = [];
  pending: QueuedMessage[] = [];

  constructor(readonly name = 'founderdata-mail') {}

  async send(body: unknown, opts: QueueSendOptions = {}) {
    const m = { id: `msg-${++seq}`, body: structuredClone(body), attempts: 1, delaySeconds: opts.delaySeconds };
    this.sent.push(m);
    this.pending.push(m);
  }

  async sendBatch(messages: Iterable<MessageSendRequest<unknown>>, opts: QueueSendBatchOptions = {}) {
    for (const m of messages) await this.send(m.body, { delaySeconds: m.delaySeconds ?? opts.delaySeconds });
  }

  /** Put messages on the queue as Cloudflare would (its sending events, say), without recording them as sent. */
  push(...bodies: unknown[]) {
    for (const body of bodies) this.pending.push({ id: `msg-${++seq}`, body, attempts: 1 });
  }

  /**
   * Hand the pending messages to `handler` (TestWorker.queue) in batches of `batchSize`, as the consumer would. A message
   * that is retried goes back on the queue with one more attempt, and the next round delivers it, up to `maxRounds`.
   * Delays are not waited for. A message neither acked nor retried counts as acked, as when a handler returns.
   */
  async drain(handler: QueueHandler, { batchSize = 10, maxRounds = 5 } = {}): Promise<DrainResult> {
    const out: DrainResult = { batches: 0, acked: 0, retried: 0, left: 0 };
    for (let round = 0; round < maxRounds && this.pending.length; round++) {
      const todo = this.pending.splice(0);
      for (let i = 0; i < todo.length; i += batchSize) {
        const chunk = todo.slice(i, i + batchSize);
        const batch = messageBatch(this.name, chunk);
        out.batches++;
        try {
          await handler(batch);
        } catch {
          // A handler that throws retries the whole batch, as Cloudflare does.
          for (const m of batch.messages) if (!batch.outcome.get(m.id)) batch.outcome.set(m.id, 'retry');
        }
        for (const m of chunk) {
          if (batch.outcome.get(m.id) === 'retry') {
            out.retried++;
            this.pending.push({ ...m, attempts: m.attempts + 1 });
          } else out.acked++;
        }
      }
    }
    out.left = this.pending.length;
    return out;
  }

  asBinding(): Queue {
    return this as unknown as Queue;
  }
}

/** A MessageBatch for the Worker's queue() export, recording what the handler did with each message in `outcome`. */
export function messageBatch(queue: string, messages: QueuedMessage[]): MessageBatch<unknown> & { outcome: Map<string, 'ack' | 'retry'> } {
  const outcome = new Map<string, 'ack' | 'retry'>();
  return {
    queue,
    outcome,
    messages: messages.map((m) => ({
      id: m.id,
      timestamp: new Date(),
      body: m.body,
      attempts: m.attempts,
      ack: () => void outcome.set(m.id, 'ack'),
      retry: () => void outcome.set(m.id, 'retry'),
    })),
    ackAll: () => messages.forEach((m) => outcome.set(m.id, 'ack')),
    retryAll: () => messages.forEach((m) => outcome.set(m.id, 'retry')),
  } as unknown as MessageBatch<unknown> & { outcome: Map<string, 'ack' | 'retry'> };
}

/** A send() call the FakeSendEmail saw. */
export interface SentMail {
  /** The structured message (EmailMessageBuilder), or for a raw EmailMessage its from, to and raw text. */
  message: Record<string, any>;
  messageId: string;
}

/** Throw this from a FakeSendEmail: a plain Error with a string `code`, like Cloudflare's binding. */
export function codedError(code: string | undefined, message: string): Error & { code?: string } {
  const e = new Error(message) as Error & { code?: string };
  if (code) e.code = code;
  return e;
}

/**
 * The send_email binding. Records each send and answers `{ messageId: "<random@sending domain>" }`, the format the
 * spike measured. `failNext(code, message)` makes the next send throw a coded error instead (a missing code is the
 * oversize case: an internal error without one).
 */
export class FakeSendEmail {
  readonly sent: SentMail[] = [];
  private failures: (Error & { code?: string })[] = [];

  failNext(code: string | undefined, message = 'failed') {
    this.failures.push(codedError(code, message));
    return this;
  }

  async send(message: any): Promise<{ messageId: string }> {
    const failure = this.failures.shift();
    if (failure) throw failure;
    const from = typeof message.from === 'string' ? message.from : message.from?.email ?? '';
    const domain = /@([^>\s]+)>?\s*$/.exec(from)?.[1] ?? 'mail-test.example';
    const messageId = `<${Array.from({ length: 36 }, () => 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'[Math.floor(Math.random() * 62)]).join('')}@${domain}>`;
    this.sent.push({ message, messageId });
    return { messageId };
  }

  asBinding(): SendEmail {
    return this as unknown as SendEmail;
  }
}

/** An inbound message for the Worker's email() export, with what the handler did to it. */
export interface FakeInboundMessage extends ForwardableEmailMessage {
  rejected: string | null;
  forwarded: { rcptTo: string; headers?: Headers }[];
  replies: unknown[];
}

/** The header block of a raw RFC 5322 message, unfolded. */
function headersOf(raw: string): Headers {
  const end = raw.search(/\r?\n\r?\n/);
  const block = (end < 0 ? raw : raw.slice(0, end)).replace(/\r?\n[ \t]+/g, ' ');
  const h = new Headers();
  for (const line of block.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) h.append(line.slice(0, i).trim(), line.slice(i + 1).trim());
  }
  return h;
}

/**
 * A ForwardableEmailMessage built from a raw MIME string, as Email Routing hands it over: `from` is the envelope sender
 * (a bounce address in real mail, so code must read the From header), `to` the one envelope recipient.
 */
export function inboundMessage(raw: string, envelope: { from: string; to: string }): FakeInboundMessage {
  const bytes = enc.encode(raw);
  const m: FakeInboundMessage = {
    from: envelope.from,
    to: envelope.to,
    headers: headersOf(raw),
    get raw() {
      return new Response(bytes).body!;
    },
    rawSize: bytes.byteLength,
    canBeForwarded: true,
    rejected: null,
    forwarded: [],
    replies: [],
    setReject(reason: string) {
      m.rejected = reason;
    },
    async forward(rcptTo: string, headers?: Headers) {
      m.forwarded.push({ rcptTo, headers });
      return { messageId: `<fwd-${++seq}@mail-test.example>` };
    },
    async reply(message: unknown) {
      m.replies.push(message);
      return { messageId: `<reply-${++seq}@mail-test.example>` };
    },
  } as unknown as FakeInboundMessage;
  return m;
}

/** A small raw message for tests: headers, a blank line and a text body. */
export function rawMail(h: { from: string; to: string; subject?: string; messageId?: string; inReplyTo?: string; references?: string; date?: string }, body = 'Hello'): string {
  const lines = [
    `From: ${h.from}`,
    `To: ${h.to}`,
    `Subject: ${h.subject ?? 'Test'}`,
    `Message-ID: ${h.messageId ?? `<test-${++seq}@sender.example>`}`,
    `Date: ${h.date ?? new Date().toUTCString()}`,
    ...(h.inReplyTo ? [`In-Reply-To: ${h.inReplyTo}`] : []),
    ...(h.references ? [`References: ${h.references}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  return `${lines.join('\r\n')}\r\n\r\n${body}\r\n`;
}
