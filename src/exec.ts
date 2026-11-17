/**
 * Runs kcli for profile.ts, in Node. A browser build gets exec.browser.ts
 * instead (package.json's "browser" field), so no bundler meets
 * node:child_process.
 */
import { execFile } from "node:child_process";
import { KasmProfileError } from "./errors.js";

/** How long kcli may take, signing in included. */
const kcliTimeoutMs = 120_000;

/** Run kcli with args and return what it printed on stdout. */
export function execKcli(kcli: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = execFile(kcli, args, { timeout: kcliTimeoutMs, maxBuffer: 1 << 20, encoding: "utf8" }, (err, stdout, stderr) => {
      if (!err) return resolve(stdout);
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return reject(new KasmProfileError(`kcli is not installed, or "${kcli}" is not on PATH: install kcli, or give Kasm the URL and credentials directly`));
      }
      if (err.killed) return reject(new KasmProfileError(`kcli config credentials did not answer within ${kcliTimeoutMs / 1000} s`));
      reject(new KasmProfileError(`kcli config credentials: ${stderr.trim() || err.message}`));
    });
    child.stdin?.end();
  });
}
