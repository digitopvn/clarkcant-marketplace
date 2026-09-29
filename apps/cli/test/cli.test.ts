import { beforeAll, describe, expect, it } from "vitest";

import { resetDatabase, seedPackage, testDeps } from "../../../packages/marketplace/test/support/seed";
import { createInProcessSite } from "../../../packages/sdk/test/support/in-process-site";
import { EXIT, MemoryTokenStore, parsePackageRef, runCli } from "../src";

const suffix = Date.now().toString(36);
const ADMIN_EMAIL = `cli-admin-${suffix}@example.test`;
const MEMBER_EMAIL = `cli-member-${suffix}@example.test`;
const site = createInProcessSite({ adminEmails: [ADMIN_EMAIL] });

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  json<T = Record<string, unknown>>(): T;
}

function harness(options: { env?: Record<string, string> } = {}) {
  const tokenStore = new MemoryTokenStore();
  const run = async (...argv: string[]): Promise<Run> => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(argv, {
      stdout: (text) => void (stdout += text),
      stderr: (text) => void (stderr += text),
      env: { CLARK_MARKET_API_URL: site.origin, ...options.env },
      tokenStore,
      fetch: site.fetch,
    });
    const lines = stdout.trim().split("\n");
    return { code, stdout, stderr, json: <T>() => JSON.parse(lines.at(-1) ?? "null") as T };
  };
  return { run, tokenStore };
}

let adminCookie = "";
let memberCookie = "";

beforeAll(async () => {
  const deps = testDeps();
  await resetDatabase(deps);
  await seedPackage(deps, {
    name: "@acme/clock-widget",
    displayName: "Clock",
    description: "A tidy desk clock",
    keywords: ["clock"],
    publisher: { slug: "acme", name: "Acme" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  adminCookie = await site.signUp(ADMIN_EMAIL);
  memberCookie = await site.signUp(MEMBER_EMAIL);
});

describe("public commands", () => {
  it("searches and shows a package, as text and as JSON", async () => {
    const { run } = harness();
    const text = await run("search", "clock");
    expect(text.code).toBe(EXIT.ok);
    expect(text.stdout).toContain("@acme/clock-widget@1.0.0  A tidy desk clock");

    const json = await run("search", "clock", "--limit", "5", "--json");
    expect(json.json<{ items: { name: string }[] }>().items.map((item) => item.name)).toEqual(["@acme/clock-widget"]);

    const info = await run("--json", "info", "@acme/clock-widget");
    expect(info.json()).toMatchObject({ name: "@acme/clock-widget", latestVersion: "1.0.0" });
    expect((await run("info", "@acme/clock-widget")).stdout).toContain("facets: widget/isolated-ui");
  });

  it("maps failures to documented exit codes and JSON errors", async () => {
    const { run } = harness();
    const missing = await run("info", "@acme/missing", "--json");
    expect(missing.code).toBe(EXIT.notFound);
    expect(missing.json()).toMatchObject({ error: { code: "not_found", status: 404 } });

    const human = await run("info", "@acme/missing");
    expect(human.stderr).toMatch(/^clark-market: .*\(request [\w-]+\)\n$/);

    expect((await run("search", "x", "--limit", "0")).code).toBe(EXIT.usage);
    expect((await run("frobnicate")).code).toBe(EXIT.usage);
    expect((await run("whoami", "--json")).json()).toMatchObject({ error: { code: "unauthorized" } });
    expect((await run("whoami")).code).toBe(EXIT.auth);
    expect((await run("--api-url", "not a url", "search", "x")).code).toBe(EXIT.usage);

    const offline = await runCli(["search", "x"], {
      stdout: () => undefined,
      stderr: () => undefined,
      env: { CLARK_MARKET_API_URL: site.origin },
      tokenStore: new MemoryTokenStore(),
      fetch: () => Promise.reject(new TypeError("connection refused")),
    });
    expect(offline).toBe(EXIT.network);
    expect((await run("--help")).code).toBe(EXIT.ok);
  });

  it("parses scoped package references", () => {
    expect(parsePackageRef("@acme/clock-widget")).toEqual({ name: "@acme/clock-widget" });
    expect(parsePackageRef("@acme/clock-widget@1.2.0")).toEqual({ name: "@acme/clock-widget", version: "1.2.0" });
    expect(parsePackageRef("left-pad@1.3.0")).toEqual({ name: "left-pad", version: "1.3.0" });
  });
});

describe("account commands", () => {
  it("logs in with the device flow, submits, and logs out", async () => {
    const { run, tokenStore } = harness();
    // `--json` login prints the pending instructions (with the user code) before it starts waiting.
    let stdout = "";
    let approved = false;
    const code = await runCli(["login", "--json"], {
      stdout: (text) => void (stdout += text),
      stderr: () => undefined,
      env: { CLARK_MARKET_API_URL: site.origin },
      tokenStore,
      fetch: site.fetch,
      sleep: async (ms) => {
        // Stands in for the user approving in the browser during the first wait; waits honour the real interval.
        if (!approved) {
          approved = true;
          const pending = JSON.parse(stdout.split("\n")[0] ?? "{}") as { status?: string; userCode?: string };
          expect(pending.status).toBe("pending");
          await site.approveDevice(pending.userCode ?? "", memberCookie);
        }
        await new Promise((resolve) => setTimeout(resolve, ms));
      },
    });
    const login = { code, stdout };
    expect(login.code).toBe(EXIT.ok);
    expect(JSON.parse(login.stdout.trim().split("\n").at(-1) ?? "{}")).toMatchObject({ status: "logged_in", email: MEMBER_EMAIL });
    expect((await tokenStore.get(site.origin))?.kind).toBe("device");

    expect((await run("whoami")).stdout).toContain(MEMBER_EMAIL);
    const submitted = await run("submit", "@acme/notes-widget@2.1.0", "--json");
    expect(submitted.code).toBe(EXIT.ok);
    expect(submitted.json()).toMatchObject({ created: true, submission: { packageName: "@acme/notes-widget", version: "2.1.0" } });
    expect((await run("submit", "Not A Package")).code).toBe(EXIT.invalid);

    const denied = await run("publish-page", "home", "--json");
    expect(denied.code).toBe(EXIT.auth);

    const logout = await run("logout", "--json");
    expect(logout.json()).toMatchObject({ status: "logged_out", revoked: true });
    expect(await tokenStore.get(site.origin)).toBeNull();
    expect((await run("whoami")).code).toBe(EXIT.auth);
  }, 30_000);

  it("publishes the latest page draft for an admin and refuses a stale one", async () => {
    const token = await site.createToken(adminCookie, ["pages:read", "pages:write", "pages:publish"]);
    const { run } = harness({ env: { CLARK_MARKET_TOKEN: token } });
    const created = await site.fetch(
      new Request(`${site.origin}/api/v1/admin/pages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ slug: `cli-${suffix}`, kind: "landing", title: "CLI landing" }),
      }),
    );
    expect(created.status).toBe(201);

    const published = await run("publish-page", `cli-${suffix}`, "--json");
    expect(published.code).toBe(EXIT.ok);
    expect(published.json()).toMatchObject({ status: "published" });
    expect((await run("publish-page", `cli-${suffix}`)).stdout).toContain("already live");
    expect((await run("publish-page", "no-such-page")).code).toBe(EXIT.notFound);
  });
});
