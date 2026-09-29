import { createApi } from "@marketplace/api";
import { AUTH_BASE_PATH, createAuthRuntime, type AuthRuntime } from "@marketplace/auth";
import { parseRuntimeVars, type IngestMessage, type RuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps, type MarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";

/**
 * The marketplace site assembled in-process for interface tests (SDK, CLI, MCP): the real `/api/v1` app and
 * Better Auth handler over the test D1/R2, reachable through a `fetch` function. Nothing is mocked except the
 * ingest queue producer, which records what it was sent.
 */
export interface InProcessSite {
  origin: string;
  vars: RuntimeVars;
  secret: string;
  sent: IngestMessage[];
  deps(): MarketplaceDeps;
  authFor(request: Request): AuthRuntime;
  /** Routes `/api/auth/*` to Better Auth and everything under `/api/v1` to the API app. */
  fetch(request: Request): Promise<Response>;
  /** Creates an account and returns its session cookie (`better-auth.session_token=…`). */
  signUp(email: string): Promise<string>;
  /** Claims and approves a device-flow `userCode` for the account behind `cookie` (what `/device` does). */
  approveDevice(userCode: string, cookie: string): Promise<void>;
  /** Mints a personal API token (`cmk_…`) for the account behind `cookie`. */
  createToken(cookie: string, scopes: string[]): Promise<string>;
}

export function createInProcessSite(options: { origin?: string; adminEmails?: string[] } = {}): InProcessSite {
  const origin = options.origin ?? "http://localhost:4325";
  const secret = `site-test-${crypto.randomUUID()}-${crypto.randomUUID()}`;
  const vars = parseRuntimeVars({
    PUBLIC_SITE_URL: origin,
    ENVIRONMENT: "development",
    ADMIN_EMAILS: (options.adminEmails ?? []).join(","),
  });
  const sent: IngestMessage[] = [];
  // Structural double of the queue producer: the services only call `send`.
  const queue = { send: async (message: IngestMessage) => void sent.push(message) } as unknown as Queue<IngestMessage>;
  const deps = () => createMarketplaceDeps({ d1: env.DB, media: env.MEDIA, queue });
  const authFor = (request: Request) => createAuthRuntime({ deps: deps(), vars, secrets: { BETTER_AUTH_SECRET: secret }, request });
  const api = createApi({ resolveContext: () => ({ deps: deps(), vars }), resolveAuth: (request) => authFor(request) });

  const fetch = async (request: Request): Promise<Response> => {
    const path = new URL(request.url).pathname;
    if (path === AUTH_BASE_PATH || path.startsWith(`${AUTH_BASE_PATH}/`)) return authFor(request).auth.handler(request);
    return api.request(request);
  };

  const authPost = (path: string, body: unknown, cookie?: string) =>
    fetch(
      new Request(`${origin}${AUTH_BASE_PATH}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );

  const signUp = async (email: string): Promise<string> => {
    const response = await authPost("/sign-up/email", { email, password: "correct horse battery", name: email.split("@")[0] });
    if (response.status !== 200) throw new Error(`sign-up failed with ${response.status}: ${await response.text()}`);
    const cookie = response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0] ?? "")
      .find((entry) => entry.startsWith("better-auth.session_token="));
    if (!cookie) throw new Error("sign-up returned no session cookie");
    return cookie;
  };

  const approveDevice = async (userCode: string, cookie: string): Promise<void> => {
    const claim = await fetch(
      new Request(`${origin}${AUTH_BASE_PATH}/device?user_code=${encodeURIComponent(userCode)}`, { headers: { origin, cookie } }),
    );
    if (!claim.ok) throw new Error(`device claim failed with ${claim.status}: ${await claim.text()}`);
    const approve = await authPost("/device/approve", { userCode }, cookie);
    if (!approve.ok) throw new Error(`device approval failed with ${approve.status}: ${await approve.text()}`);
  };

  const createToken = async (cookie: string, scopes: string[]): Promise<string> => {
    const response = await fetch(
      new Request(`${origin}/api/v1/me/tokens`, {
        method: "POST",
        headers: { "content-type": "application/json", origin, cookie },
        body: JSON.stringify({ name: `test-${crypto.randomUUID().slice(0, 8)}`, scopes }),
      }),
    );
    if (response.status !== 201) throw new Error(`token creation failed with ${response.status}: ${await response.text()}`);
    return ((await response.json()) as { token: string }).token;
  };

  return { origin, vars, secret, sent, deps, authFor, fetch, signUp, approveDevice, createToken };
}
