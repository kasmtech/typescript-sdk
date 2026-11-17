# @kasmweb/sdk (TypeScript)

TypeScript client for the Kasm Workspaces API, generated from the official OpenAPI spec.

```
npm install @kasmweb/sdk
```

```ts
import { Kasm, apiKey, NotFoundError } from "@kasmweb/sdk";

const kasm = new Kasm({ baseUrl: "https://kasm.example.com", auth: apiKey(key, secret) });
const img = await kasm.admin.catalog.images.get(imageId);
await kasm.admin.catalog.fileMappings.update(fileMapId, { description: null });   // null clears it
for await (const zone of kasm.admin.infrastructure.zones.iter({})) {
  console.log(zone.zone_name);
}
```

The client's properties follow kcli's command tree (`kcli admin catalog
images get` is `kasm.admin.catalog.images.get`). Path parameters are
positional, then the request body, then the query parameters. A method
resolves to the decoded success body, or nothing for an operation that
replies with none. Paged lists also have `iter`, an async iterable over every
page, numbered from 0 as in the API. `undefined` leaves a field out and
`null` sends null. A multipart body takes a `Blob` or `File` for its file
fields.

Every non-2xx reply rejects with a `KasmApiError` subclass by status
(`NotFoundError`, `ConflictError`, `ValidationError`, `ForbiddenError`,
`ServerError`, ...) carrying the problem+json fields, field-level `errors`
from a 422, and the response `headers`. A problem type whose schema adds
fields has a class of its own under its status's (`NoResourcesError` is a
`ConflictError`), with `problem` typed. A failure before any reply is a
`KasmConnectionError`. A 2xx reply that is not the JSON the spec declares,
including `null`, rejects too.

The package runs in Node, Deno, Bun and browsers (checked in Chromium,
Firefox and WebKit). Bundlers pick its browser build through the `browser`
field, which leaves out the kcli runner `fromProfile` needs; in a browser no
`User-Agent` is set unless you give one, and the deployment must allow the
page's origin (CORS).

`await Kasm.fromProfile("staging")` uses a profile kcli is set up with,
through `kcli config credentials` (Node only): kcli supplies the URL, timeout
and the credential, and renews a password profile's session token. With no
name it is the environment's (`KASM_URL`, `KASM_API_KEY`,
`KASM_API_KEY_SECRET`) when it gives all three, otherwise the active profile.

`bearer(token)` authenticates with a session token, and `bearer(source)` with
a `TokenSource`, which is asked for a fresh token once after a 401.
`Kasm.login(options, username, password)` signs in and returns a client
acting as that user, which the self-service operations need. `kasm.request`
sends any operation by method and path. The `retries` option sends a GET,
PUT or DELETE refused with 429 or 503 again, after the server's
`Retry-After`. `dispatcher` (Node) passes an undici Agent with TLS settings
to fetch, for a test deployment with a self-signed certificate. Printing a
reply with Node's `console.log` masks its secret fields.

`src/services.gen.ts` (the methods), `src/problems.gen.ts` (the problem
types' classes) and `src/generated/schema.ts` (the types,
from openapi-typescript) are generated and never hand-edited. `npm test`
typechecks and
runs the unit tests.

## About this repository

This package is generated from the Kasm Workspaces OpenAPI spec, in the same
run as the Python and Go SDKs, and published here from Kasm's kcli
repository: one commit and one `vX.Y.Z` tag per release, and anything
changed here directly is overwritten by the next. kcli and the three SDKs
share a version number. They are 0.x: no compatibility promise until the
API surface settles.

Licensed under the [Apache License 2.0](LICENSE).
