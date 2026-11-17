/**
 * The transport every Kasm method sends through: auth, the base URL, path
 * and query encoding, JSON and multipart bodies, and the error contract.
 */
import { errorFrom, KasmConnectionError } from "./errors.js";
import { credentialRE, notSecretRE, secretRE } from "./secrets.gen.js";
import { VERSION } from "./version.js";

/** Applies credentials to a request. apiKey and bearer make one. */
export interface Auth {
  apply(headers: Headers): Promise<void>;
  /** Forget a token the server refused, so the next apply gets a fresh one. Present only when that can help. */
  refresh?(): void;
}

/** A source of bearer tokens that can replace a token the server refused. */
export interface TokenSource {
  token(): Promise<string>;
  invalidate(): void;
}

/** HTTP Basic with a developer API key and its secret. */
export function apiKey(key: string, secret: string): Auth {
  const value = "Basic " + btoa(`${key}:${secret}`);
  return { apply: async (h) => h.set("Authorization", value) };
}

/**
 * A bearer token: a fixed one, or a TokenSource, which is asked for a new
 * token once after a 401.
 */
export function bearer(token: string | TokenSource): Auth {
  if (typeof token === "string") {
    return { apply: async (h) => h.set("Authorization", `Bearer ${token}`) };
  }
  return {
    apply: async (h) => h.set("Authorization", `Bearer ${await token.token()}`),
    refresh: () => token.invalidate(),
  };
}

export interface KasmOptions {
  /** The deployment, e.g. https://kasm.example.com */
  baseUrl: string;
  auth: Auth;
  /** A fetch implementation; the global one by default. */
  fetch?: typeof fetch;
  /**
   * Node only: an undici Dispatcher (an Agent with TLS settings, say, such as
   * `new Agent({ connect: { rejectUnauthorized: false } })` for a test
   * deployment), passed to fetch with each request. Without one, Node's
   * global dispatcher decides, NODE_EXTRA_CA_CERTS included.
   */
  dispatcher?: object;
  /**
   * The User-Agent header: "kasm-sdk-ts/<version>" by default outside a browser. In a
   * browser none is set unless given, since it is not a CORS-safelisted
   * header and the deployment would have to allow it.
   */
  userAgent?: string;
  /** Per-request timeout in milliseconds; 30 s by default, 0 for none. */
  timeoutMs?: number;
  /**
   * How many times a GET, PUT or DELETE refused with 429 or 503 is sent
   * again: 0 (off) by default. Each waits for the server's Retry-After (up to
   * 60 s; a longer one is not waited for) or an exponential backoff.
   */
  retries?: number;
}

/**
 * A multipart body: each string field may also be a Blob (or a File, whose
 * name is sent as the filename), for the file parts.
 */
export type FormBody<T> = { [K in keyof T]: T[K] extends string | null | undefined ? T[K] | Blob : T[K] };

/** What call returns, by what the operation replies with on success. */
export type Kind = "json" | "none" | "binary";

interface Init {
  path?: Record<string, string | number>;
  query?: object;
  body?: unknown;
  form?: boolean;
}

/** The fields a paged list's reply has. */
export interface Page<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

const maxResponse = 64 << 20;

// Retries (off unless asked for): idempotent methods only, on these
// statuses, honouring Retry-After up to maxRetryAfterMs, else backing off
// exponentially from retryBaseMs.
const retryMethods = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const retryStatuses = new Set([429, 503]);
const retryBaseMs = 500;
const maxRetryAfterMs = 60_000;

/**
 * How long to wait before sending a refused request again, or undefined not
 * to: when retries are used up, the method is not idempotent, the status is
 * not one to retry, or the server asks for a longer wait than maxRetryAfterMs.
 */
export function retryDelay(response: Response, method: string, tries: number, retries: number): number | undefined {
  if (tries >= retries || !retryMethods.has(method.toUpperCase()) || !retryStatuses.has(response.status)) return undefined;
  const after = response.headers.get("retry-after");
  if (after === null) return retryBaseMs * 2 ** tries * (0.5 + Math.random() / 2);
  let ms = Number(after) * 1000;
  if (after.trim() === "" || Number.isNaN(ms)) {
    const when = Date.parse(after);
    if (Number.isNaN(when)) return undefined;
    ms = when - Date.now();
  }
  ms = Math.max(ms, 0);
  return ms <= maxRetryAfterMs ? ms : undefined;
}

export class Transport {
  readonly baseUrl: string;
  private readonly auth: Auth;
  private readonly fetch: typeof fetch;
  private readonly userAgent: string | undefined;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly dispatcher: object | undefined;

  constructor(options: KasmOptions) {
    if (!options.baseUrl?.trim()) throw new Error("baseUrl is required");
    if (!options.auth) throw new Error("auth is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.auth = options.auth;
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.userAgent = options.userAgent ?? (inBrowser() ? undefined : `kasm-sdk-ts/${VERSION}`);
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retries = options.retries ?? 0;
    this.dispatcher = options.dispatcher;
  }

  /** Send one operation and return its decoded success body (see Kind). */
  async call(operation: string, method: string, path: string, init: Init, kind: Kind): Promise<any> {
    const url = this.baseUrl + expandPath(path, init.path ?? {}) + encodeQuery(init.query);
    let body: BodyInit | undefined;
    let contentType: string | undefined;
    if (init.form) {
      body = formData(operation, init.body);
    } else if (init.body !== undefined) {
      body = JSON.stringify(init.body);
      contentType = "application/json";
    }
    const response = await this.send(operation, method, url, body, contentType);
    return read(operation, response, kind);
  }

  /**
   * Every item of a paged list, fetching page after page from start (0 by
   * default). Each traversal starts over from start.
   */
  pages<T>(fetchPage: (page: number) => Promise<Page<T>>, start?: number | null): AsyncIterable<T> {
    return {
      async *[Symbol.asyncIterator]() {
        let page = start ?? 0;
        for (;;) {
          const r = await fetchPage(page);
          yield* r.data;
          if (r.data.length === 0 || r.page_size <= 0 || (r.page + 1) * r.page_size >= r.total) return;
          page++;
        }
      },
    };
  }

  /**
   * Send a request with the client's headers and auth, resending once with a
   * fresh token after a 401, and, when retries are on, after a 429 or 503
   * (retryDelay).
   */
  async send(operation: string, method: string, url: string, body?: BodyInit, contentType?: string, extra?: HeadersInit): Promise<Response> {
    let refreshed = false;
    for (let tries = 0; ; ) {
      // Extra headers first: the client's own, auth included, go over them.
      const headers = new Headers(extra);
      if (this.userAgent) headers.set("User-Agent", this.userAgent);
      headers.set("Accept", "application/json, application/problem+json");
      if (contentType) headers.set("Content-Type", contentType);
      await this.auth.apply(headers);
      let response: Response;
      try {
        response = await this.fetch(url, {
          method,
          headers,
          body,
          signal: this.timeoutMs > 0 ? AbortSignal.timeout(this.timeoutMs) : undefined,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        } as RequestInit);
      } catch (e) {
        throw new KasmConnectionError(operation, e);
      }
      if (response.status === 401 && !refreshed && this.auth.refresh) {
        // The refused reply is discarded; failing to discard it does not stop the retry.
        await response.body?.cancel().catch(() => {});
        this.auth.refresh();
        refreshed = true;
        continue;
      }
      const delay = retryDelay(response, method, tries, this.retries);
      if (delay === undefined) return response;
      await response.body?.cancel().catch(() => {});
      await new Promise((r) => setTimeout(r, delay));
      tries++;
    }
  }
}

/** Read a reply: the error for a non-2xx status, before any decoding; the success body otherwise. */
export async function read(operation: string, response: Response, kind: Kind): Promise<any> {
  if (kind === "binary" && response.ok) {
    try {
      return await response.blob();
    } catch (e) {
      throw new Error(`${operation}: reading the reply: ${e instanceof Error ? e.message : e}`, { cause: e });
    }
  }
  const { text, error: readError } = await readText(response);
  if (!response.ok) throw errorFrom(operation, response, text, readError);
  if (readError !== undefined) {
    throw new Error(`${operation}: reading the reply: ${readError instanceof Error ? readError.message : readError}`, { cause: readError });
  }
  if (kind === "none") return undefined;
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("json")) {
    throw new Error(`${operation}: HTTP ${response.status} reply is not the JSON the spec declares (Content-Type "${ct}")`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`${operation}: HTTP ${response.status} reply does not decode as JSON: ${e instanceof Error ? e.message : e}`, { cause: e });
  }
  if (value === null) throw new Error(`${operation}: HTTP ${response.status} reply is null, where the spec declares a value`);
  return markSecrets(value);
}

/**
 * A reply's body as text, up to maxResponse bytes, counted as they arrive:
 * a longer body is cancelled at the limit, not read into memory. When the
 * body cannot be read in full, what was read comes with the error, so the
 * status that did arrive can still be reported.
 */
async function readText(response: Response): Promise<{ text: string; error?: unknown }> {
  if (!response.body) return { text: "" };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { text: text + decoder.decode() };
      size += value.byteLength;
      if (size > maxResponse) {
        text += decoder.decode(value.subarray(0, value.byteLength - (size - maxResponse)));
        await reader.cancel().catch(() => {});
        return { text, error: new Error(`reply larger than ${maxResponse} bytes`) };
      }
      text += decoder.decode(value, { stream: true });
    }
  } catch (e) {
    return { text: text + decoder.decode(), error: e };
  }
}

/** Whether this runs in a browser (or a worker in one), not Node, Deno or Bun. */
function inBrowser(): boolean {
  const g = globalThis as { window?: unknown; document?: unknown; importScripts?: unknown; process?: { versions?: { node?: string } } };
  return !g.process?.versions?.node && (g.document !== undefined || typeof g.importScripts === "function");
}

const inspectCustom = Symbol.for("nodejs.util.inspect.custom");

/** Whether a key holding v is a secret, by the CLI's rule (secrets.gen.ts). */
function secretKey(key: string, v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (credentialRE.test(key)) return true;
  return typeof v === "string" && v !== "" && secretRE.test(key) && !notSecretRE.test(key);
}

/**
 * Give every object in a reply that holds a secret a Node inspection hook
 * (util.inspect, console.log) that prints it with the secret masked. A
 * secret that is itself an object or array (a credential object such as
 * gcp_credentials) gets a hook on it and on everything inside it that masks
 * all its values, so it stays masked when inspected on its own. The hook is
 * a non-enumerable symbol, so the values, property access and
 * JSON.stringify are untouched. Browsers' consoles do not call it.
 */
export function markSecrets<T>(v: T): T {
  if (Array.isArray(v)) {
    for (const e of v) markSecrets(e);
  } else if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    let holds = false;
    for (const [k, e] of Object.entries(o)) {
      if (secretKey(k, e)) {
        holds = true;
        markSecret(e);
      } else {
        markSecrets(e);
      }
    }
    if (holds) inspectAs(o, (k, e) => (secretKey(k, e) ? "***" : e));
  }
  return v;
}

/** Hook every object and array in a secret to print with all its values masked. */
function markSecret(v: unknown): void {
  if (v === null || typeof v !== "object") return;
  for (const e of Object.values(v)) markSecret(e);
  inspectAs(v as Record<string, unknown>, (_k, e) => (e === null || e === undefined ? e : "***"));
}

/** Make Node inspect o as a copy of it with each value replaced by show(key, value). */
function inspectAs(o: Record<string, unknown>, show: (k: string, e: unknown) => unknown): void {
  Object.defineProperty(o, inspectCustom, {
    enumerable: false,
    configurable: true,
    value(_depth: number, options: object, inspect: (v: unknown, o: object) => string) {
      const copy: unknown = Array.isArray(o) ? o.map((e, i) => show(String(i), e)) : Object.fromEntries(Object.entries(o).map(([k, e]) => [k, show(k, e)]));
      return inspect(copy, options);
    },
  });
}

/** Substitute {name} placeholders, each value escaped as one path segment. */
export function expandPath(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const v = values[name];
    if (v === undefined || v === "") throw new Error(`path ${template}: no value for {${name}}`);
    return encodeURIComponent(String(v));
  });
}

/** Encode query parameters: undefined and null are left out, and an array repeats its key. */
export function encodeQuery(query: object | undefined): string {
  if (!query) return "";
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue;
    for (const item of Array.isArray(v) ? v : [v]) {
      q.append(k, typeof item === "object" ? JSON.stringify(item) : String(item));
    }
  }
  const s = q.toString();
  return s ? "?" + s : "";
}

/**
 * Encode a multipart body: Blobs as file parts, other values as form fields
 * (objects as JSON). Undefined fields are left out; a form has no null, so a
 * null field is an error rather than silently dropped.
 */
export function formData(operation: string, body: unknown): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries((body ?? {}) as Record<string, unknown>)) {
    if (v === undefined) continue;
    if (v === null) throw new Error(`${operation}: ${k}: a multipart form cannot send null; leave the field unset`);
    if (v instanceof Blob) {
      form.append(k, v, v instanceof File ? v.name : k);
    } else {
      form.append(k, typeof v === "object" ? JSON.stringify(v) : String(v));
    }
  }
  return form;
}
