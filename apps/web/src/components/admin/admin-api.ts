/** Same-origin JSON calls from the page builder to `/api/v1/admin/*`. The session cookie authenticates them. */

export interface ApiIssue {
  path?: (string | number)[];
  message: string;
  blockId?: string;
}

export class AdminApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly issues: ApiIssue[];

  constructor(status: number, code: string, message: string, issues: ApiIssue[]) {
    super(message);
    this.name = "AdminApiError";
    this.status = status;
    this.code = code;
    this.issues = issues;
  }
}

function issuesFrom(details: unknown): ApiIssue[] {
  if (!Array.isArray(details)) return [];
  return details.flatMap((entry): ApiIssue[] => {
    if (!entry || typeof entry !== "object") return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.message !== "string") return [];
    return [
      {
        message: record.message,
        ...(Array.isArray(record.path) ? { path: record.path.filter((part) => typeof part === "string" || typeof part === "number") } : {}),
        ...(typeof record.blockId === "string" ? { blockId: record.blockId } : {}),
      },
    ];
  });
}

export interface AdminRequestInit {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Revision the change is based on; sent as `If-Match`. */
  ifMatch?: string | null | undefined;
  signal?: AbortSignal;
}

export async function adminRequest<T>(path: string, init: AdminRequestInit = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { accept: "application/json" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.ifMatch) headers["if-match"] = `"${init.ifMatch}"`;
  // Every write gets its own key, so a network-level retry of the same attempt can never apply twice.
  if (method !== "GET") headers["idempotency-key"] = crypto.randomUUID();

  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method,
      credentials: "same-origin",
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      ...(init.signal ? { signal: init.signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new AdminApiError(0, "network_error", "Could not reach the server. Check your connection and try again.", []);
  }

  const text = await response.text();
  let body: unknown = null;
  if (text !== "") {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
  }
  if (!response.ok) {
    const error = body && typeof body === "object" ? (body as { error?: Record<string, unknown> }).error : undefined;
    throw new AdminApiError(
      response.status,
      typeof error?.code === "string" ? error.code : "http_error",
      typeof error?.message === "string" ? error.message : `Request failed (${response.status})`,
      issuesFrom(error?.details),
    );
  }
  return body as T;
}

export function describeError(error: unknown): string {
  if (error instanceof AdminApiError) {
    if (error.code === "conflict") return "Someone saved or published a newer revision. Reload to continue from it.";
    if (error.status === 401) return "Your session has ended. Sign in again.";
    if (error.status === 403) return `Not allowed: ${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export function formatDateTime(value: string | null | undefined): string {
  if (!value) return "never";
  return new Date(value).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
