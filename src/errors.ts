/**
 * Errors: every non-2xx reply is a KasmApiError (a subclass by status, or by
 * problem type where the type's schema adds fields: problems.gen.ts), and a
 * failure before any reply is a KasmConnectionError.
 */

/** A field-level message from a 422 reply. */
export interface FieldError {
  loc: (string | number)[];
  msg: string;
}

/** The parts of a KasmApiError taken from the reply body. */
export interface ErrorFields {
  type?: string;
  title?: string;
  detail?: string;
  instance?: string;
  errors?: FieldError[];
  problem?: Record<string, unknown>;
}

/** An API error: the RFC 9457 problem+json fields when the server sent them, the status otherwise. */
export class KasmApiError extends Error {
  /** The operationId, e.g. "admin.infrastructure.zones.list". */
  readonly operation: string;
  readonly status: number;
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly instance: string;
  /** Field-level messages from a 422. */
  readonly errors: FieldError[];
  /** The response headers, for Retry-After and the like. */
  readonly headers: Headers;
  /** The decoded body when it is a JSON object, with any fields the problem type adds. */
  readonly problem: Record<string, unknown> | undefined;

  constructor(operation: string, status: number, fields: ErrorFields, headers: Headers) {
    const title = fields.title || statusText(status);
    let message = `${operation}: ${status} ${title}`;
    if (fields.detail) message += `: ${fields.detail}`;
    for (const e of fields.errors ?? []) message += `\n  - ${e.loc.join(".")}: ${e.msg}`;
    super(message);
    this.name = new.target.name;
    this.operation = operation;
    this.status = status;
    this.type = fields.type ?? "";
    this.title = title;
    this.detail = fields.detail ?? "";
    this.instance = fields.instance ?? "";
    this.errors = fields.errors ?? [];
    this.headers = headers;
    this.problem = fields.problem;
  }
}

export class BadRequestError extends KasmApiError {}
export class UnauthenticatedError extends KasmApiError {}
/** 403: a missing permission, or a feature the licence lacks. */
export class ForbiddenError extends KasmApiError {}
export class NotFoundError extends KasmApiError {}
export class ConflictError extends KasmApiError {}
export class PayloadTooLargeError extends KasmApiError {}
export class ValidationError extends KasmApiError {}
export class RateLimitedError extends KasmApiError {}
/** Any 5xx. */
export class ServerError extends KasmApiError {}

/**
 * A kcli profile that cannot be used: kcli is not installed, the profile
 * does not exist or cannot authenticate as configured, or kcli's answer is
 * not one this SDK reads.
 */
export class KasmProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KasmProfileError";
  }
}

/** A failure before any HTTP reply: DNS, TLS, a refused connection, a timeout or an abort. */
export class KasmConnectionError extends Error {
  readonly operation: string;
  constructor(operation: string, cause: unknown) {
    super(`${operation}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = "KasmConnectionError";
    this.operation = operation;
  }
}

/** A problem type's error class, and the status it is raised for (0: any). */
interface ProblemClass {
  status: number;
  cls: typeof KasmApiError;
}

const problemTypes = new Map<string, ProblemClass>();

/** Register the problem types' classes; problems.gen.ts calls it. @internal */
export function registerProblems(types: Record<string, ProblemClass>): void {
  for (const [type, c] of Object.entries(types)) problemTypes.set(type, c);
}

const byStatus: Record<number, typeof KasmApiError> = {
  400: BadRequestError,
  401: UnauthenticatedError,
  403: ForbiddenError,
  404: NotFoundError,
  409: ConflictError,
  413: PayloadTooLargeError,
  422: ValidationError,
  429: RateLimitedError,
};

/**
 * The error for a non-2xx reply. text is the body as read; readError, when
 * the body could not be read in full, is noted in the detail. The status is
 * known from the headers, so it is never lost to a malformed or truncated body.
 */
export function errorFrom(operation: string, response: Response, text: string, readError?: unknown): KasmApiError {
  const ct = response.headers.get("content-type") ?? "";
  const fields: ErrorFields = {};
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : undefined;
  } catch {
    body = undefined;
  }
  const obj = body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (ct.startsWith("application/problem+json") && obj) {
    fields.title = str(obj.title);
    fields.detail = str(obj.detail);
    fields.type = str(obj.type);
    fields.instance = str(obj.instance);
    fields.problem = obj;
  } else if (response.status === 422 && obj && Array.isArray(obj.detail)) {
    fields.errors = obj.detail.filter(isFieldError);
  } else if (text && text.length < 512) {
    fields.detail = text.trim();
  }
  if (readError !== undefined) {
    const why = readError instanceof Error ? readError.message : String(readError);
    fields.detail = `${fields.detail ?? ""} (the reply body could not be read in full: ${why})`.trim();
  }
  let Cls = byStatus[response.status] ?? (response.status >= 500 ? ServerError : KasmApiError);
  const problem = fields.type ? problemTypes.get(fields.type) : undefined;
  if (problem && (problem.status === 0 || problem.status === response.status)) Cls = problem.cls;
  return new Cls(operation, response.status, fields, response.headers);
}

/** Whether a 422 detail entry has the shape of a FieldError; others are left out. */
function isFieldError(v: unknown): v is FieldError {
  if (v === null || typeof v !== "object") return false;
  const { loc, msg } = v as Record<string, unknown>;
  return typeof msg === "string" && Array.isArray(loc) && loc.every((l) => typeof l === "string" || typeof l === "number");
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function statusText(status: number): string {
  const texts: Record<number, string> = {
    400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 409: "Conflict",
    413: "Payload Too Large", 422: "Unprocessable Entity", 429: "Too Many Requests", 500: "Internal Server Error",
    502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout",
  };
  return texts[status] ?? `HTTP ${status}`;
}
