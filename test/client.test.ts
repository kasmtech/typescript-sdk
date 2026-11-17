import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  apiKey, bearer, ConflictError, ForbiddenError, Kasm, KasmApiError, KasmConnectionError,
  NoResourcesError, NotFoundError, RateLimitedError, ServerError, UnauthenticatedError, ValidationError, type TokenSource,
} from "../src/index.js";

type Handler = (req: IncomingMessage, body: string, res: ServerResponse) => void;

async function serve(handler: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const sockets = new Set<Socket>();
  const srv = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => handler(req, body, res));
  });
  srv.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); srv.close(() => r()); }),
  };
}

function json(res: ServerResponse, status: number, body: string, ct = "application/json") {
  res.writeHead(status, { "Content-Type": ct });
  res.end(body);
}

const zone = (name: string) => ({ zone_id: "6c2f3f6e-9a4e-4d7c-8c6c-2b1f0d2a9e11", zone_name: name });

test("a typed call sends auth, path and query and returns the decoded reply", async () => {
  let seen: { auth?: string; path?: string; body?: string } = {};
  const s = await serve((req, body, res) => {
    seen = { auth: req.headers.authorization, path: req.url, body };
    json(res, 200, JSON.stringify({ data: [zone("default")], page: 0, page_size: 50, total: 1 }));
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    const page = await kasm.admin.infrastructure.zones.list({ page_size: 50, sort_direction: "desc" });
    assert.equal(seen.auth, "Basic azpz");
    assert.equal(seen.path, "/api/admin/infrastructure/zones?page_size=50&sort_direction=desc");
    assert.equal(seen.body, "");
    assert.equal(page.data[0].zone_name, "default");
  } finally { await s.close(); }
});

test("iter walks every page from page 0, and starts over on each traversal", async () => {
  const pages: number[] = [];
  const s = await serve((req, _body, res) => {
    const page = Number(new URL(req.url ?? "", "http://x").searchParams.get("page"));
    pages.push(page);
    const data = page === 0 ? [zone("a"), zone("b")] : [zone("c")];
    json(res, 200, JSON.stringify({ data, page, page_size: 2, total: 3 }));
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    const seq = kasm.admin.infrastructure.zones.iter({});
    for (let i = 0; i < 2; i++) {
      const names: string[] = [];
      for await (const z of seq) names.push(z.zone_name);
      assert.deepEqual(names, ["a", "b", "c"]);
    }
    assert.deepEqual(pages, [0, 1, 0, 1]);
  } finally { await s.close(); }
});

test("query parameters, path parameters and a 204", async () => {
  let url = "";
  const s = await serve((req, _b, res) => { url = `${req.method} ${req.url}`; res.writeHead(204); res.end(); });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    await kasm.admin.identity.groups.delete("68d5c0a2-0a7c-4c7b-9a0e-3f3a1b2c4d5e", { force: true });
    assert.equal(url, "DELETE /api/admin/identity/groups/68d5c0a2-0a7c-4c7b-9a0e-3f3a1b2c4d5e?force=true");
  } finally { await s.close(); }
});

test("non-2xx replies are the subclass for their status, malformed or truncated bodies included", async () => {
  const cases: [number, string, string, Function][] = [
    [403, "application/problem+json", `{"title":"Forbidden","status":403,"detail":"developer_api not licensed"}`, ForbiddenError],
    [404, "application/problem+json", `{"title":"Not Fo`, NotFoundError],
    [409, "application/problem+json", ``, ConflictError],
    [422, "application/json", `{"detail":[{"loc":["body","page_size"],"msg":"must be <= 100"}]}`, ValidationError],
    [401, "application/json", `{}`, UnauthenticatedError],
    [502, "text/html", `<html>Bad Gateway</html>`, ServerError],
  ];
  for (const [status, ct, body, cls] of cases) {
    const s = await serve((_q, _b, res) => json(res, status, body, ct));
    try {
      const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
      await assert.rejects(kasm.admin.infrastructure.zones.list({}), (e: unknown) => {
        assert.ok(e instanceof cls && e instanceof KasmApiError, `${status}: ${e}`);
        assert.equal((e as KasmApiError).status, status);
        assert.equal((e as KasmApiError).operation, "admin.infrastructure.zones.list");
        return true;
      });
    } finally { await s.close(); }
  }
});

test("a problem's fields, validation messages and headers are on the error", async () => {
  const s = await serve((_q, _b, res) => {
    res.writeHead(422, { "Content-Type": "application/json", "Retry-After": "30" });
    res.end(`{"detail":[{"loc":["body","page_size"],"msg":"must be <= 100"}]}`);
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    const e = (await kasm.admin.infrastructure.zones.list({}).catch((x) => x)) as ValidationError;
    assert.deepEqual(e.errors, [{ loc: ["body", "page_size"], msg: "must be <= 100" }]);
    assert.equal(e.message, "admin.infrastructure.zones.list: 422 Unprocessable Entity\n  - body.page_size: must be <= 100");
    assert.equal(e.headers.get("retry-after"), "30");
  } finally { await s.close(); }
});

test("a problem type whose schema adds fields has its own class under its status's", async () => {
  const body = { type: "no-resources", title: "No resources", status: 409, detail: "try later", reason: "no agent has 4 cores" };
  for (const [status, want] of [[409, NoResourcesError], [500, ServerError]] as const) {
    const s = await serve((_q, _b, res) => json(res, status, JSON.stringify(body), "application/problem+json"));
    try {
      const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
      const e = await kasm.session.sessions.create({ image_id: "6c2f3f6e-9a4e-4d7c-8c6c-2b1f0d2a9e11" }).catch((x) => x);
      assert.ok(e instanceof want, `${status}: ${e?.constructor?.name}`);
      if (e instanceof NoResourcesError) {
        assert.ok(e instanceof ConflictError);
        const reason: string | null | undefined = e.problem.reason;
        assert.equal(reason, "no agent has 4 cores");
      }
    } finally { await s.close(); }
  }
});

test("a 422 with malformed detail entries is still a ValidationError", async () => {
  for (const body of [`{"detail":[null]}`, `{"detail":[{"loc":"body","msg":"bad"}]}`, `{"detail":[{"loc":["body","x"],"msg":"ok"},7]}`]) {
    const s = await serve((_q, _b, res) => json(res, 422, body));
    try {
      const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
      const e = await kasm.admin.infrastructure.zones.list({}).catch((x) => x);
      assert.ok(e instanceof ValidationError && e.status === 422, `${body}: ${e}`);
      assert.ok(e.errors.every((f: { msg: unknown }) => typeof f.msg === "string"), body);
    } finally { await s.close(); }
  }
});

test("a 401 whose body stream has errored still refreshes the token and resends", async () => {
  const auths: (string | null)[] = [];
  let invalidated = 0;
  const fakeFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    auths.push(auth);
    if (auth !== "Bearer new") {
      const broken = new ReadableStream({ start(c) { c.error(new Error("stream broke")); } });
      return new Response(broken, { status: 401 });
    }
    return new Response(JSON.stringify({ data: [], page: 0, page_size: 50, total: 0 }), { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  let tok = "old";
  const src: TokenSource = { token: async () => tok, invalidate: () => { invalidated++; tok = "new"; } };
  const kasm = new Kasm({ baseUrl: "https://kasm.example.com", auth: bearer(src), fetch: fakeFetch });
  await kasm.admin.infrastructure.zones.list({});
  assert.deepEqual(auths, ["Bearer old", "Bearer new"]);
  assert.equal(invalidated, 1);
});

test("a reply over the size limit is cancelled at the limit, not read in full", async () => {
  const chunk = new Uint8Array(1 << 20).fill(0x20);
  let pulled = 0;
  let cancelled = false;
  const fakeFetch = (async () => {
    const endless = new ReadableStream<Uint8Array>({
      pull(c) { pulled += chunk.byteLength; c.enqueue(chunk); },
      cancel() { cancelled = true; },
    }, { highWaterMark: 0 });
    return new Response(endless, { headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  const kasm = new Kasm({ baseUrl: "https://kasm.example.com", auth: apiKey("k", "s"), fetch: fakeFetch });
  await assert.rejects(kasm.admin.infrastructure.zones.list({}), /larger than 67108864 bytes/);
  assert.ok(cancelled, "the body was not cancelled");
  assert.ok(pulled <= (64 << 20) + 2 * chunk.byteLength, `read ${pulled} bytes`);
});

test("a truncated error body keeps its status", async () => {
  const s = await serve((_q, _b, res) => {
    res.writeHead(403, { "Content-Type": "application/problem+json", "Content-Length": "200" });
    res.flushHeaders();
    res.write(`{"title":"Forb`);
    setTimeout(() => res.socket?.destroy(), 50);
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    const e = await kasm.admin.infrastructure.zones.list({}).catch((x) => x);
    assert.ok(e instanceof ForbiddenError, String(e));
    assert.match(e.detail, /could not be read in full/);
  } finally { await s.close(); }
});

test("a null or non-JSON success is an error, never an empty result", async () => {
  for (const [body, ct, want] of [["null", "application/json", /reply is null/], ["<html/>", "text/html", /not the JSON the spec declares/]] as const) {
    const s = await serve((_q, _b, res) => json(res, 200, body, ct));
    try {
      const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
      await assert.rejects(kasm.admin.identity.groups.permissions.list("68d5c0a2-0a7c-4c7b-9a0e-3f3a1b2c4d5e"), want);
    } finally { await s.close(); }
  }
});

test("null is sent as null and undefined is left out", async () => {
  let sent: Record<string, unknown> = {};
  const s = await serve((_q, body, res) => { sent = JSON.parse(body); json(res, 200, JSON.stringify({ group_id: "x", name: "g" })); });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    await kasm.admin.identity.groups.update("6c2f3f6e-9a4e-4d7c-8c6c-2b1f0d2a9e11", { description: null, name: undefined });
    assert.deepEqual(sent, { description: null });
  } finally { await s.close(); }
});

test("multipart: a Blob is a file part, other fields are form values, null is refused", async () => {
  let ct = "", raw = "";
  const s = await serve((req, body, res) => { ct = req.headers["content-type"] ?? ""; raw = body; json(res, 200, JSON.stringify({ file_map_id: "x" })); });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    await kasm.admin.catalog.fileMappings.uploads.create({
      name: "motd", destination: "/home/kasm-user/motd.txt", file: new File(["hi"], "motd.txt"), is_executable: true,
    });
    assert.match(ct, /^multipart\/form-data; boundary=/);
    assert.match(raw, /name="file"; filename="motd.txt"[\s\S]*hi/);
    assert.match(raw, /name="is_executable"\r\n\r\ntrue/);
    await assert.rejects(
      kasm.admin.catalog.fileMappings.uploads.create({ name: "m", destination: "/d", file: new Blob(["x"]), image_id: null }),
      /image_id: a multipart form cannot send null/,
    );
  } finally { await s.close(); }
});

test("a refreshing bearer token is replaced once after a 401", async () => {
  let calls = 0, invalidated = 0;
  const s = await serve((req, _b, res) => {
    calls++;
    if (req.headers.authorization !== "Bearer new") return json(res, 401, "{}");
    json(res, 200, JSON.stringify({ data: [], page: 0, page_size: 50, total: 0 }));
  });
  try {
    let tok = "old";
    const src: TokenSource = { token: async () => tok, invalidate: () => { invalidated++; tok = "new"; } };
    const kasm = new Kasm({ baseUrl: s.url, auth: bearer(src) });
    await kasm.admin.infrastructure.zones.list({});
    assert.equal(calls, 2);
    assert.equal(invalidated, 1);
    const fixed = new Kasm({ baseUrl: s.url, auth: bearer("static") });
    await assert.rejects(fixed.admin.infrastructure.zones.list({}), UnauthenticatedError);
    assert.equal(calls, 3);
  } finally { await s.close(); }
});

test("a refused connection is a KasmConnectionError", async () => {
  const s = await serve(() => {});
  const url = s.url;
  await s.close();
  const kasm = new Kasm({ baseUrl: url, auth: apiKey("k", "s") });
  await assert.rejects(kasm.admin.infrastructure.zones.list({}), KasmConnectionError);
});

test("request sends any operation by path", async () => {
  const s = await serve((req, _b, res) => json(res, 200, JSON.stringify({ path: req.url })));
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    assert.deepEqual(await kasm.request("GET", "/api/x/{id}", { path: { id: "a b" }, query: { n: 1 } }), { path: "/api/x/a%20b?n=1" });
  } finally { await s.close(); }
});

test("retries are off by default, and then only for idempotent methods", async () => {
  let calls: string[] = [];
  const s = await serve((req, _b, res) => {
    calls.push(req.method!);
    if (calls.length < 3) {
      res.writeHead(503, { "Content-Type": "application/problem+json", "Retry-After": "0" });
      return res.end(`{"title":"busy"}`);
    }
    res.writeHead(204);
    res.end();
  });
  try {
    const off = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    assert.ok((await off.admin.infrastructure.zones.delete("z").catch((x) => x)) instanceof ServerError);
    assert.deepEqual(calls, ["DELETE"]);
    calls = [];
    const on = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s"), retries: 3 });
    assert.ok((await on.session.sessions.create({ image_id: "6c2f3f6e-9a4e-4d7c-8c6c-2b1f0d2a9e11" }).catch((x) => x)) instanceof ServerError);
    assert.deepEqual(calls, ["POST"]);
    calls = [];
    await on.admin.infrastructure.zones.delete("z");
    assert.deepEqual(calls, ["DELETE", "DELETE", "DELETE"]);
  } finally { await s.close(); }
});

test("a Retry-After too long is not waited for", async () => {
  let calls = 0;
  const s = await serve((_q, _b, res) => {
    calls++;
    res.writeHead(429, { "Content-Type": "application/problem+json", "Retry-After": "3600" });
    res.end(`{"title":"slow down"}`);
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s"), retries: 5 });
    const e = await kasm.admin.catalog.images.get("i").catch((x) => x);
    assert.ok(e instanceof RateLimitedError);
    assert.equal(calls, 1);
    assert.equal(e.headers.get("retry-after"), "3600");
  } finally { await s.close(); }
});

test("request sends extra headers under its own", async () => {
  let seen: Record<string, string | string[] | undefined> = {};
  const s = await serve((req, _b, res) => {
    seen = req.headers;
    res.writeHead(204);
    res.end();
  });
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    await kasm.request("POST", "/api/x", { body: {}, headers: { "Idempotency-Key": "abc", Authorization: "Bearer stolen" } });
    assert.equal(seen["idempotency-key"], "abc");
    assert.equal(seen.authorization, "Basic azpz");
  } finally { await s.close(); }
});

test("a reply's secrets are masked when Node inspects it, and kept otherwise", async () => {
  const { inspect } = await import("node:util");
  const created = { api_key: "KEY", api_key_secret: "hunter2", name: "ci", enabled: true, created: "2026-10-01T12:00:00Z", api_id: "a", read_only: false, expires: null, last_used: null };
  const gcp = { vm_provider_name: "GCP", gcp_credentials: { private_key: "PEM", client_email: "x@example.com", scopes: ["scope-1"], nested: { k: "deep" } }, nested: [{ password: "pw-1" }], force_password_reset: true };
  const s = await serve((req, _b, res) => json(res, 200, JSON.stringify(req.url?.includes("vm-configs") ? gcp : created)));
  try {
    const kasm = new Kasm({ baseUrl: s.url, auth: apiKey("k", "s") });
    const key = await kasm.admin.identity.apiConfigs.create({ name: "ci" });
    const shown = inspect(key) + inspect([key], { depth: 4 });
    assert.ok(!shown.includes("hunter2") && shown.includes("***") && shown.includes("KEY"), shown);
    assert.equal(key.api_key_secret, "hunter2");
    assert.ok(JSON.stringify(key).includes("hunter2"));
    const vm = (await kasm.request("GET", "/api/admin/providers/vm-configs/x")) as { gcp_credentials: { private_key: string; scopes: string[]; nested: object } };
    const vmShown = inspect(vm, { depth: 6 });
    assert.ok(!vmShown.includes("PEM") && !vmShown.includes("pw-1") && vmShown.includes("force_password_reset: true"), vmShown);
    const credShown = inspect(vm.gcp_credentials) + inspect(vm.gcp_credentials.scopes) + inspect(vm.gcp_credentials.nested);
    assert.ok(!/PEM|x@example|scope-1|deep/.test(credShown) && credShown.includes("***"), credShown);
    assert.equal(vm.gcp_credentials.private_key, "PEM");
    assert.ok(JSON.stringify(vm).includes("PEM"));
  } finally { await s.close(); }
});
