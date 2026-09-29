import { MarketplaceApiError, networkError } from "./errors";

/*
 * OAuth 2.0 Device Authorization Grant (RFC 8628) against the marketplace's Better Auth endpoints. Used by CLI
 * login: request a code, show the user the verification URL, then poll until they approve or deny. The resulting
 * access token is sent as `Authorization: Bearer` and carries the account's scopes without `admin`.
 */

export const DEVICE_CODE_PATH = "/api/auth/device/code";
export const DEVICE_TOKEN_PATH = "/api/auth/device/token";
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  /** Seconds until the code expires. */
  expiresIn: number;
  /** Minimum seconds between polls. */
  interval: number;
}

export interface DeviceToken {
  accessToken: string;
  tokenType: string;
  /** Seconds until expiry, when the server reports it. */
  expiresIn: number | null;
  scope: string | null;
}

export interface DeviceFlowOptions {
  baseUrl: string;
  clientId: string;
  fetch?: (request: Request) => Promise<Response>;
}

export interface PollOptions extends DeviceFlowOptions {
  code: DeviceCode;
  signal?: AbortSignal;
  /** Injectable for tests; defaults to a timer that honours `signal`. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each wait, e.g. to show progress. */
  onPending?: (secondsUntilNextPoll: number) => void;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function postJson(options: DeviceFlowOptions, path: string, body: Record<string, string>, signal?: AbortSignal) {
  const request = new Request(new URL(path, options.baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
  let response: Response;
  try {
    response = await (options.fetch ?? ((input: Request) => globalThis.fetch(input)))(request);
  } catch (error) {
    throw networkError(error);
  }
  const text = await response.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new MarketplaceApiError({ code: "invalid_response", message: `non-JSON answer from ${path}`, status: response.status });
  }
  return { response, json: (json && typeof json === "object" ? json : {}) as Record<string, unknown> };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function oauthError(status: number, json: Record<string, unknown>): MarketplaceApiError {
  const code = str(json.error) ?? (status >= 500 ? "internal_error" : "bad_request");
  const message = str(json.error_description) ?? str(json.message) ?? code;
  return new MarketplaceApiError({ code, message, status });
}

export async function requestDeviceCode(options: DeviceFlowOptions & { scope?: string; signal?: AbortSignal }): Promise<DeviceCode> {
  const body: Record<string, string> = { client_id: options.clientId };
  if (options.scope) body.scope = options.scope;
  const { response, json } = await postJson(options, DEVICE_CODE_PATH, body, options.signal);
  if (!response.ok) throw oauthError(response.status, json);
  const deviceCode = str(json.device_code);
  const userCode = str(json.user_code);
  const verificationUri = str(json.verification_uri);
  if (!deviceCode || !userCode || !verificationUri) {
    throw new MarketplaceApiError({ code: "invalid_response", message: "device code response is incomplete", status: response.status });
  }
  const absolute = new URL(verificationUri, options.baseUrl).href;
  const complete = str(json.verification_uri_complete);
  return {
    deviceCode,
    userCode,
    verificationUri: absolute,
    verificationUriComplete: complete ? new URL(complete, options.baseUrl).href : `${absolute}?user_code=${encodeURIComponent(userCode)}`,
    expiresIn: num(json.expires_in) ?? 600,
    interval: Math.max(1, num(json.interval) ?? 5),
  };
}

/**
 * Polls until the user approves (resolves with the token) or the flow ends: `access_denied` (user denied),
 * `expired_token` (code expired) or an abort via `signal`. Honours `slow_down` by widening the interval by 5 s.
 */
export async function pollDeviceToken(options: PollOptions): Promise<DeviceToken> {
  const sleep = options.sleep ?? defaultSleep;
  let interval = options.code.interval;
  const deadline = Date.now() + options.code.expiresIn * 1000;
  for (;;) {
    options.onPending?.(interval);
    await sleep(interval * 1000, options.signal);
    if (Date.now() > deadline) {
      throw new MarketplaceApiError({ code: "expired_token", message: "the device code expired before it was approved", status: 400 });
    }
    const { response, json } = await postJson(
      options,
      DEVICE_TOKEN_PATH,
      { grant_type: DEVICE_GRANT_TYPE, device_code: options.code.deviceCode, client_id: options.clientId },
      options.signal,
    );
    if (response.ok) {
      const accessToken = str(json.access_token);
      if (!accessToken) throw new MarketplaceApiError({ code: "invalid_response", message: "token response has no access_token", status: response.status });
      return {
        accessToken,
        tokenType: str(json.token_type) ?? "Bearer",
        expiresIn: num(json.expires_in) ?? null,
        scope: str(json.scope) ?? null,
      };
    }
    const error = str(json.error);
    if (error === "authorization_pending") continue;
    // Rate limiting (429) means the same as `slow_down`: poll less often rather than give up.
    if (error === "slow_down" || response.status === 429) {
      interval += 5;
      continue;
    }
    throw oauthError(response.status, json);
  }
}
