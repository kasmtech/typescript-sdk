import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kasm, KasmProfileError } from "../src/index.js";

const base = "https://kasm.example.com";

/** A fake kcli that records its arguments and prints the answers it is given, in turn. */
function fakeKcli(answers: unknown[], code = 0): { path: string; calls: () => string[][] } {
  const dir = mkdtempSync(join(tmpdir(), "kcli-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  const path = join(dir, "kcli");
  writeFileSync(path, `#!${process.execPath}
const fs = require("node:fs");
const d = ${JSON.stringify(dir)};
fs.appendFileSync(d + "/calls.log", JSON.stringify(process.argv.slice(2)) + "\\n");
const answers = JSON.parse(fs.readFileSync(d + "/answers.json", "utf8"));
const n = fs.readFileSync(d + "/calls.log", "utf8").trim().split("\\n").length - 1;
const a = answers[Math.min(n, answers.length - 1)];
if (${code}) { process.stderr.write(a); process.exit(${code}); }
process.stdout.write(typeof a === "string" ? a : JSON.stringify(a));
`);
  chmodSync(path, 0o755);
  const log = join(dir, "calls.log");
  return { path, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []) };
}

const answer = (o: object) => ({ version: 1, profile: "lab", url: base, verify_tls: true, timeout: 30, ...o });

function recording(statusFor: (auth: string) => number): { fetch: typeof fetch; auths: string[] } {
  const auths: string[] = [];
  const f = (async (_url: string | URL | Request, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    auths.push(auth);
    return new Response(null, { status: statusFor(auth) });
  }) as typeof fetch;
  return { fetch: f, auths };
}

test("an API key profile", async () => {
  const k = fakeKcli([answer({ auth: "api_key", api_key: "k", api_key_secret: "s" })]);
  const r = recording(() => 204);
  const kasm = await Kasm.fromProfile("lab", { kcli: k.path, fetch: r.fetch });
  assert.equal(kasm.baseUrl, base);
  await kasm.admin.infrastructure.zones.delete("z");
  assert.deepEqual(r.auths, ["Basic azpz"]);
  assert.deepEqual(k.calls(), [["config", "credentials", "--profile", "lab"]]);
});

test("a password profile's token is renewed through kcli after a 401", async () => {
  const k = fakeKcli([answer({ auth: "bearer", token: "t1", expires_at: "2099-01-01T00:00:00Z" }), answer({ auth: "bearer", token: "t2" })]);
  const r = recording((auth) => (auth === "Bearer t1" ? 401 : 204));
  const kasm = await Kasm.fromProfile("lab", { kcli: k.path, fetch: r.fetch });
  await kasm.admin.infrastructure.zones.delete("z");
  assert.deepEqual(r.auths, ["Bearer t1", "Bearer t2"]);
  assert.deepEqual(k.calls()[1], ["config", "credentials", "--profile", "lab", "--refresh"]);
});

test("kcli missing, failing or too new", async () => {
  await assert.rejects(Kasm.fromProfile("lab", { kcli: "/nonexistent/kcli" }), /kcli is not installed/);
  await assert.rejects(Kasm.fromProfile("x", { kcli: fakeKcli(['profile "x" not found; available: default\n'], 2).path }), /profile "x" not found/);
  for (const [bad, why] of [[answer({ version: 2, auth: "api_key" }), /newer than this SDK/], ["Usage: kcli", /did not print JSON/], [answer({ auth: "bearer" }), /no token/]] as const) {
    await assert.rejects(Kasm.fromProfile("lab", { kcli: fakeKcli([bad]).path }), (e: unknown) => e instanceof KasmProfileError && why.test(e.message));
  }
  // verify_tls = false is left to Node's dispatcher, not refused.
  const noTLS = fakeKcli([answer({ auth: "api_key", api_key: "k", api_key_secret: "s", verify_tls: false })]);
  assert.equal((await Kasm.fromProfile("lab", { kcli: noTLS.path })).baseUrl, base);
});
