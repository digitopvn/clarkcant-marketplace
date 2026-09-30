import {
  MarketplaceApiError,
  createMarketplaceClient,
  isMarketplaceApiError,
  pollDeviceToken,
  requestDeviceCode,
  type MarketplaceClient,
} from "@marketplace/sdk";
import { Command, CommanderError } from "commander";

import type { TokenStore } from "./token-store";

export const CLI_NAME = "clark-market";
export const CLI_VERSION = "0.1.0";
/** The public client id Better Auth accepts for the device flow. */
export const DEVICE_CLIENT_ID = "clark-market-cli";
export const DEFAULT_API_URL = "https://marketplace.clarkcant.cc";

/** Documented exit codes (docs/cli.md). */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  auth: 3,
  notFound: 4,
  conflict: 5,
  invalid: 6,
  network: 7,
} as const;

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  tokenStore: TokenStore;
  /** Defaults to `globalThis.fetch`; tests pass the in-process site. */
  fetch?: (request: Request) => Promise<Response>;
  /** Device-flow wait; injectable so tests need not sleep. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
}

interface GlobalOptions {
  json?: boolean;
  apiUrl?: string;
}

class CliError extends Error {
  readonly code: string;
  readonly exitCode: number;

  constructor(code: string, message: string, exitCode: number) {
    super(message);
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function exitCodeFor(error: unknown): number {
  if (error instanceof CliError) return error.exitCode;
  if (!isMarketplaceApiError(error)) return EXIT.error;
  switch (error.code) {
    case "unauthorized":
    case "forbidden":
    case "access_denied":
    case "expired_token":
      return EXIT.auth;
    case "not_found":
      return EXIT.notFound;
    case "conflict":
    case "idempotency_key_reused":
    case "idempotency_in_progress":
      return EXIT.conflict;
    case "validation_failed":
    case "bad_request":
      return EXIT.invalid;
    case "network_error":
      return EXIT.network;
    default:
      return EXIT.error;
  }
}

/** `@scope/name@1.2.3` → name and version; a leading `@` belongs to the scope. */
export function parsePackageRef(ref: string): { name: string; version?: string } {
  const at = ref.lastIndexOf("@");
  if (at <= 0) return { name: ref };
  const version = ref.slice(at + 1);
  if (!version) throw new CliError("validation_failed", `missing version after "@" in ${ref}`, EXIT.usage);
  return { name: ref.slice(0, at), version };
}

function parseLimit(value: string): number {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new CliError("validation_failed", "--limit must be 1-100", EXIT.usage);
  return limit;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
}

/**
 * The origin every request (and so every bearer token) goes to. Only https is accepted, except plain http on a
 * loopback host for local development, so a mistyped or hostile `--api-url` never carries a token in clear text.
 */
function checkedOrigin(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new CliError("validation_failed", `invalid --api-url: ${apiUrl}`, EXIT.usage);
  }
  if (url.protocol === "https:" || (url.protocol === "http:" && isLoopbackHost(url.hostname))) return url.origin;
  throw new CliError(
    "validation_failed",
    `refusing --api-url ${url.protocol}//${url.host}: use https (plain http is allowed only for localhost, *.localhost, 127.0.0.1 and [::1])`,
    EXIT.usage,
  );
}

/**
 * Runs one CLI invocation and resolves with its exit code. Never calls `process.exit`, so tests (and embedders)
 * drive it in-process. Every command talks to the marketplace only through `@marketplace/sdk`.
 */
export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  let jsonMode = argv.includes("--json");
  const print = (human: string, data: unknown) => io.stdout(`${jsonMode ? JSON.stringify(data) : human}\n`);

  const program = new Command()
    .name(CLI_NAME)
    .description("Find, inspect and submit ClarkCant widgets on the ClarkCant Marketplace.")
    .version(CLI_VERSION)
    .option("--json", "print machine-readable JSON")
    .option("--api-url <url>", "marketplace origin (default: $CLARK_MARKET_API_URL or production)")
    .exitOverride()
    .configureOutput({ writeOut: (text) => io.stdout(text), writeErr: (text) => io.stderr(text) });

  const context = () => {
    const options = program.opts<GlobalOptions>();
    jsonMode = Boolean(options.json);
    const apiUrl = options.apiUrl ?? io.env.CLARK_MARKET_API_URL ?? DEFAULT_API_URL;
    const origin = checkedOrigin(apiUrl);
    const token = async () => io.env.CLARK_MARKET_TOKEN || (await io.tokenStore.get(origin))?.token;
    const client: MarketplaceClient = createMarketplaceClient({
      baseUrl: origin,
      token,
      headers: { "user-agent": `${CLI_NAME}/${CLI_VERSION}` },
      ...(io.fetch ? { fetch: io.fetch } : {}),
    });
    return { origin, client, token };
  };

  const requireLogin = async (token: () => Promise<string | undefined>) => {
    if (!(await token())) throw new CliError("unauthorized", `not logged in; run \`${CLI_NAME} login\` first`, EXIT.auth);
  };

  program
    .command("search")
    .description("search widgets and packages")
    .argument("<query...>", "words to search for")
    .option("--limit <n>", "results per page (1-100)", parseLimit)
    .option("--category <slug>", "only this category")
    .option("--kind <kind>", "only this facet kind, e.g. widget")
    .action(async (words: string[], options: { limit?: number; category?: string; kind?: string }) => {
      const { client } = context();
      const result = await client.search({ q: words.join(" "), limit: options.limit, category: options.category, kind: options.kind });
      const lines = result.items.map((item) => `${item.name}${item.latestVersion ? `@${item.latestVersion}` : ""}  ${item.description}`);
      print(lines.length > 0 ? lines.join("\n") : `No packages match "${result.query}".`, result);
    });

  program
    .command("info")
    .description("show a package: versions, facets and permissions")
    .argument("<name>", "npm package name, e.g. @acme/clock-widget")
    .action(async (name: string) => {
      const { client } = context();
      const detail = await client.getPackage(name);
      const latest = detail.latest;
      const human = [
        `${detail.displayName} (${detail.name})`,
        detail.description,
        `latest: ${detail.latestVersion ?? "none indexed"}`,
        `publisher: ${detail.publisher ? `${detail.publisher.name}${detail.publisher.verified ? " (verified)" : ""}` : "unclaimed"}`,
        ...(detail.license ? [`license: ${detail.license}`] : []),
        ...(latest ? [`facets: ${latest.facets.map((facet) => `${facet.kind}/${facet.isolation}`).join(", ") || "none"}`] : []),
        ...(latest
          ? [`permissions: ${latest.permissions.map((permission) => `${permission.kind}:${permission.value}`).join(", ") || "none"}`]
          : []),
      ].filter(Boolean);
      print(human.join("\n"), detail);
    });

  program
    .command("login")
    .description("sign in through the browser (device authorization)")
    .action(async () => {
      const { origin } = context();
      const code = await requestDeviceCode({ baseUrl: origin, clientId: DEVICE_CLIENT_ID, ...(io.fetch ? { fetch: io.fetch } : {}), signal: io.signal });
      const instructions = { verificationUri: code.verificationUri, verificationUriComplete: code.verificationUriComplete, userCode: code.userCode, expiresIn: code.expiresIn };
      if (jsonMode) io.stdout(`${JSON.stringify({ status: "pending", ...instructions })}\n`);
      else io.stderr(`Open ${code.verificationUriComplete}\nand confirm the code ${code.userCode}. Waiting for approval…\n`);
      const token = await pollDeviceToken({
        baseUrl: origin,
        clientId: DEVICE_CLIENT_ID,
        code,
        ...(io.fetch ? { fetch: io.fetch } : {}),
        ...(io.sleep ? { sleep: io.sleep } : {}),
        signal: io.signal,
      });
      await io.tokenStore.set(origin, { token: token.accessToken, kind: "device", savedAt: new Date().toISOString() });
      const profile = await createMarketplaceClient({ baseUrl: origin, token: token.accessToken, ...(io.fetch ? { fetch: io.fetch } : {}) }).me();
      print(`Logged in to ${origin} as ${profile.email}.`, { status: "logged_in", origin, email: profile.email, scopes: profile.scopes });
    });

  program
    .command("logout")
    .description("sign out and forget the stored credential")
    .action(async () => {
      const { origin } = context();
      const stored = await io.tokenStore.get(origin);
      let revoked = false;
      if (stored?.kind === "device") {
        // Best effort: end the session server-side too. The local credential is removed either way.
        try {
          const response = await (io.fetch ?? ((request: Request) => globalThis.fetch(request)))(
            new Request(`${origin}/api/auth/sign-out`, {
              method: "POST",
              headers: { authorization: `Bearer ${stored.token}`, "content-type": "application/json", origin },
              body: "{}",
            }),
          );
          revoked = response.ok;
        } catch {
          revoked = false;
        }
      }
      const removed = await io.tokenStore.delete(origin);
      print(removed ? `Logged out of ${origin}.` : `Not logged in to ${origin}.`, { status: removed ? "logged_out" : "not_logged_in", origin, revoked });
    });

  program
    .command("whoami")
    .description("show the signed-in account")
    .action(async () => {
      const { client, token } = context();
      await requireLogin(token);
      const profile = await client.me();
      print(`${profile.email} (${profile.role}) scopes: ${profile.scopes.join(" ")}`, profile);
    });

  program
    .command("submit")
    .description("ask the marketplace to index an npm package version")
    .argument("<package>", "name or name@version, e.g. @acme/clock-widget@1.2.0")
    .action(async (ref: string) => {
      const { client, token } = context();
      await requireLogin(token);
      const result = await client.submitPackage(parsePackageRef(ref));
      const { submission } = result;
      const label = `${submission.packageName}${submission.version ? `@${submission.version}` : ""}`;
      print(`${result.created ? "Submitted" : "Already queued"} ${label}: ${submission.status} (${submission.id})`, result);
    });

  program
    .command("publish-page")
    .description("admin: publish the latest draft of a marketplace page")
    .argument("<page>", "page slug (e.g. home) or id")
    .action(async (reference: string) => {
      const { client, token } = context();
      await requireLogin(token);
      const summary = (await client.listPages()).find((page) => page.id === reference || page.slug === reference);
      if (!summary) throw new MarketplaceApiError({ code: "not_found", message: `no page with slug or id "${reference}"`, status: 404 });
      const state = await client.getPage(summary.id);
      const draft = state.draft.revision;
      if (state.published?.id === draft.id) {
        print(`${summary.slug} is already live at revision ${draft.number}.`, { status: "unchanged", page: state.page, revision: draft });
        return;
      }
      // The draft id doubles as the expected revision: if someone saves meanwhile, publishing fails with a conflict.
      const published = await client.publishPage(summary.id, draft.id);
      print(`Published ${summary.slug} revision ${draft.number}.`, { status: "published", page: published.page, revision: published.published });
    });

  try {
    await program.parseAsync([...argv], { from: "user" });
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CommanderError) {
      if (error.code === "commander.helpDisplayed" || error.code === "commander.version" || error.exitCode === 0) return EXIT.ok;
      return EXIT.usage;
    }
    const code = exitCodeFor(error);
    const payload = isMarketplaceApiError(error)
      ? { code: error.code, message: error.message, status: error.status, requestId: error.requestId ?? null }
      : error instanceof CliError
        ? { code: error.code, message: error.message }
        : { code: "internal_error", message: error instanceof Error ? error.message : String(error) };
    if (jsonMode) io.stdout(`${JSON.stringify({ error: payload })}\n`);
    else io.stderr(`${CLI_NAME}: ${payload.message}${"requestId" in payload && payload.requestId ? ` (request ${payload.requestId})` : ""}\n`);
    return code;
  }
}
