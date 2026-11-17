/**
 * Kasm Workspaces API client for TypeScript.
 *
 *     const kasm = new Kasm({ baseUrl: "https://kasm.example.com", auth: apiKey(key, secret) });
 *     const img = await kasm.admin.catalog.images.get(imageId);
 *     for await (const zone of kasm.admin.infrastructure.zones.iter({})) { ... }
 *
 * The groups and methods follow kcli's command tree; they and the types in
 * `./generated/schema` are generated from the official OpenAPI spec and are
 * never hand-edited.
 */
import { services, type Services } from "./services.gen.js";
import { errorFrom, UnauthenticatedError } from "./errors.js";
import { apiKey, bearer, encodeQuery, expandPath, read, Transport, type KasmOptions } from "./transport.js";
import { fromEnv, ProfileTokens, runKcli, type ProfileOptions } from "./profile.js";

export * from "./errors.js";
export * from "./problems.gen.js";
export { VERSION } from "./version.js";
export { type ProfileOptions } from "./profile.js";
export { apiKey, bearer, type Auth, type FormBody, type KasmOptions, type TokenSource } from "./transport.js";
export type { Schemas } from "./services.gen.js";
export type * from "./services.gen.js";
export type { components, operations, paths } from "./generated/schema.js";

/** A Kasm Workspaces API client. Its properties are the API's groups, as in kcli. */
export interface Kasm extends Services {}

export class Kasm {
  readonly #t: Transport;

  constructor(options: KasmOptions) {
    this.#t = new Transport(options);
    Object.assign(this, services(this.#t));
  }

  /** The deployment this client talks to. */
  get baseUrl(): string {
    return this.#t.baseUrl;
  }

  /**
   * Send any operation by method and path, for what the typed methods do not
   * cover, with the client's auth and error handling. It resolves to the
   * decoded JSON body, or undefined when there is none. headers are extra
   * request headers (Idempotency-Key, say); the client's own, auth
   * included, are set over them.
   */
  async request(
    method: string,
    path: string,
    init: { path?: Record<string, string>; query?: object; body?: unknown; headers?: HeadersInit } = {},
  ): Promise<unknown> {
    const url = this.#t.baseUrl + expandPath(path, init.path ?? {}) + encodeQuery(init.query);
    const body = init.body === undefined ? undefined : JSON.stringify(init.body);
    const response = await this.#t.send(`${method} ${path}`, method.toUpperCase(), url, body, body ? "application/json" : undefined, init.headers);
    const empty = response.status === 204 || response.headers.get("content-length") === "0";
    return read(`${method} ${path}`, response, empty ? "none" : "json");
  }

  /**
   * A client for a kcli profile: name, or kcli's choice (KCLI_PROFILE, then
   * the active profile), resolved as kcli does, environment included. kcli
   * supplies the URL, its timeout (options given here win) and the
   * credential: an API key, or a password profile's session token, which
   * kcli renews when it expires or the server refuses it. With no name, an
   * environment that gives the URL and API key in full (KASM_URL,
   * KASM_API_KEY, KASM_API_KEY_SECRET) is used without kcli. Node only: kcli
   * must be installed, and the SDK never reads its secret store itself.
   *
   * A profile's verify_tls = false is not applied: TLS verification is
   * Node's, through its global dispatcher or the dispatcher (or fetch) given
   * in options, so a test deployment with a self-signed certificate needs
   * one that accepts it.
   */
  static async fromProfile(name?: string, options: ProfileOptions = {}): Promise<Kasm> {
    const { kcli = "kcli", ...rest } = options;
    const a = (name === undefined ? fromEnv() : undefined) ?? (await runKcli(kcli, name));
    const auth = a.auth === "api_key" ? apiKey(a.api_key as string, a.api_key_secret as string) : bearer(new ProfileTokens(kcli, a.profile, a));
    const timeoutMs = rest.timeoutMs ?? (a.timeout && a.timeout > 0 ? a.timeout * 1000 : undefined);
    return new Kasm({ ...rest, baseUrl: a.url, auth, timeoutMs });
  }

  /**
   * Sign in with a username and password and return a client acting as that
   * user, which the self-service operations need. A user who must also give
   * a second factor gets an UnauthenticatedError: password sign-in cannot
   * answer the challenge.
   */
  static async login(options: Omit<KasmOptions, "auth">, username: string, password: string): Promise<Kasm> {
    const t = new Transport({ ...options, auth: { apply: async () => {} } });
    const op = "auth.login.password";
    const response = await t.send(op, "POST", t.baseUrl + "/api/auth/login", JSON.stringify({ username, password }), "application/json");
    const out = (await read(op, response, "json")) as { outcome?: string; token?: string };
    if (out.outcome === "totp_required" || out.outcome === "webauthn_required") {
      throw new UnauthenticatedError(op, 401, {
        title: "Second factor required",
        detail: `this user must also give a second factor (${out.outcome.replace("_required", "")}), which password sign-in does not do; use an API key`,
      }, response.headers);
    }
    if (!out.token) {
      throw errorFrom(op, new Response(null, { status: 401, headers: response.headers }), `the deployment answered without a session token (outcome "${out.outcome}")`);
    }
    return new Kasm({ ...options, auth: bearer(out.token) });
  }
}
