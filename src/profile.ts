/**
 * kcli profiles: the settings and credential of a profile kcli is set up
 * with, from `kcli config credentials` (docs/sdk-design.md, decision 11).
 * The SDK never reads kcli's secret store or sees a password; kcli resolves
 * the profile, signs in when it needs to, and hands over one credential.
 * Node only: it runs kcli as a child process (exec.ts); a browser build gets
 * exec.browser.ts instead, through package.json's "browser" field.
 */
import { KasmProfileError } from "./errors.js";
import { execKcli } from "./exec.js";
import type { KasmOptions, TokenSource } from "./transport.js";

/** The `kcli config credentials` format this SDK reads; a newer one is refused. */
const formatVersion = 1;
/** A token this close to its expiry is replaced before it is used. */
const tokenMarginMs = 2 * 60_000;

/** Options for Kasm.fromProfile: the client's, without the URL and auth kcli supplies. */
export interface ProfileOptions extends Partial<Omit<KasmOptions, "baseUrl" | "auth">> {
  /** The kcli executable; "kcli" on PATH by default. */
  kcli?: string;
}

/** What `kcli config credentials` prints. */
export interface ProfileAnswer {
  version: number;
  profile: string;
  url: string;
  verify_tls?: boolean;
  timeout?: number;
  auth: "api_key" | "bearer";
  api_key?: string;
  api_key_secret?: string;
  token?: string;
  expires_at?: string;
}

/** Run `kcli config credentials` for a profile (undefined: kcli's own choice) and return its answer. */
export async function runKcli(kcli: string, profile: string | undefined, refresh = false): Promise<ProfileAnswer> {
  const args = ["config", "credentials"];
  if (profile) args.push("--profile", profile);
  if (refresh) args.push("--refresh");
  const out = await execKcli(kcli, args);
  return parse(out);
}

function parse(stdout: string): ProfileAnswer {
  let a: unknown;
  try {
    a = JSON.parse(stdout);
  } catch {
    throw new KasmProfileError("kcli config credentials did not print JSON; kcli may be too old to have it");
  }
  const o = a as Record<string, unknown>;
  if (o === null || typeof o !== "object" || typeof o.version !== "number") {
    throw new KasmProfileError("kcli config credentials printed no format version");
  }
  if (o.version > formatVersion) {
    throw new KasmProfileError(`kcli config credentials printed format ${o.version}, newer than this SDK reads (${formatVersion}); upgrade @kasmweb/sdk`);
  }
  const required: Record<string, string[]> = { api_key: ["url", "profile", "api_key", "api_key_secret"], bearer: ["url", "profile", "token"] };
  const fields = required[String(o.auth)];
  if (!fields) throw new KasmProfileError(`kcli config credentials printed an unknown auth "${String(o.auth)}"`);
  for (const f of fields) {
    if (typeof o[f] !== "string" || o[f] === "") throw new KasmProfileError(`kcli config credentials printed no ${f}`);
  }
  return o as unknown as ProfileAnswer;
}

/**
 * A password profile's session token, from kcli: the one kcli gave until it
 * nears its expiry, then a new one; after the server refuses it, one from a
 * fresh sign-in (--refresh).
 */
export class ProfileTokens implements TokenSource {
  #token: string | undefined;
  #expires: number | undefined;
  #refresh = false;
  #pending: Promise<string> | undefined;

  constructor(private readonly kcli: string, private readonly profile: string, first: ProfileAnswer) {
    this.#set(first);
  }

  #set(a: ProfileAnswer): void {
    this.#token = a.token;
    const exp = a.expires_at ? Date.parse(a.expires_at) : NaN;
    this.#expires = Number.isNaN(exp) ? undefined : exp;
  }

  token(): Promise<string> {
    if (this.#token && (this.#expires === undefined || Date.now() < this.#expires - tokenMarginMs)) {
      return Promise.resolve(this.#token);
    }
    this.#pending ??= runKcli(this.kcli, this.profile, this.#refresh)
      .then((a) => {
        this.#set(a);
        this.#refresh = false;
        return a.token as string;
      })
      .finally(() => (this.#pending = undefined));
    return this.#pending;
  }

  invalidate(): void {
    this.#token = undefined;
    this.#refresh = true;
  }
}

/**
 * The settings and API key the environment gives in full (KASM_URL,
 * KASM_API_KEY, KASM_API_KEY_SECRET), which need no kcli; undefined otherwise.
 */
export function fromEnv(): ProfileAnswer | undefined {
  const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
  const [url, key, secret] = [env.KASM_URL, env.KASM_API_KEY, env.KASM_API_KEY_SECRET];
  if (url && key && secret && (env.KCLI_AUTH ?? "api_key") === "api_key") {
    return { version: formatVersion, profile: "", url, auth: "api_key", api_key: key, api_key_secret: secret };
  }
  return undefined;
}
