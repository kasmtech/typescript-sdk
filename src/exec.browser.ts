/**
 * The browser build's exec.ts (package.json's "browser" field): there is no
 * kcli to run, so Kasm.fromProfile says so.
 */
import { KasmProfileError } from "./errors.js";

export function execKcli(_kcli: string, _args: string[]): Promise<string> {
  return Promise.reject(
    new KasmProfileError("Kasm.fromProfile runs kcli, which a browser cannot; give Kasm the URL and credentials directly"),
  );
}
