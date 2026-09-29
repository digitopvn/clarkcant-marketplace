import { beforeAll, describe, expect, it } from "vitest";

import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";
import {
  MarketplaceApiError,
  OPENAPI_DOCUMENT_SHA256,
  createMarketplaceClient,
  openApiDigest,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceCode,
} from "../src";
import { createInProcessSite } from "./support/in-process-site";

const suffix = Date.now().toString(36);
const ADMIN_EMAIL = `sdk-admin-${suffix}@example.test`;
const MEMBER_EMAIL = `sdk-member-${suffix}@example.test`;
const site = createInProcessSite({ adminEmails: [ADMIN_EMAIL] });

let adminCookie = "";
let memberCookie = "";

beforeAll(async () => {
  const deps = testDeps();
  await resetDatabase(deps);
  await seedPackage(deps, {
    name: "@acme/clock-widget",
    displayName: "Clock",
    description: "A tidy desk clock",
    keywords: ["clock", "time"],
    categorySlug: "productivity",
    publisher: { slug: "acme", name: "Acme" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
    curationStatus: "featured",
  });
  await seedPackage(deps, {
    name: "@acme/timer-widget",
    displayName: "Timer",
    description: "Counts down focus sessions",
    keywords: ["time", "focus"],
    categorySlug: "productivity",
    publisher: { slug: "tempo", name: "Tempo" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  await seedPackage(deps, {
    name: "weather-panel",
    description: "Local forecast",
    keywords: ["weather"],
    facets: [{ kind: "panel", isolation: "isolated-ui" }],
  });
  adminCookie = await site.signUp(ADMIN_EMAIL);
  memberCookie = await site.signUp(MEMBER_EMAIL);
});

describe("generated types", () => {
  it("were generated from the live OpenAPI document (run openapi:generate when this fails)", async () => {
    const response = await site.fetch(new Request(`${site.origin}/openapi.json`));
    expect(response.status).toBe(200);
    expect(await openApiDigest(await response.json())).toBe(OPENAPI_DOCUMENT_SHA256);
  });
});

describe("MarketplaceClient reads", () => {
  const client = createMarketplaceClient({ baseUrl: site.origin, fetch: site.fetch });

  it("searches, reads a scoped package, its versions and the install coordinate", async () => {
    const result = await client.search({ q: "clock" });
    expect(result.items.map((item) => item.name)).toEqual(["@acme/clock-widget"]);

    const detail = await client.getPackage("@acme/clock-widget");
    expect(detail).toMatchObject({ name: "@acme/clock-widget", latestVersion: "1.0.0" });
    expect((await client.listPackageVersions("@acme/clock-widget")).map((version) => version.version)).toEqual(["1.0.0"]);
    const install = await client.getPackageInstall("@acme/clock-widget");
    expect(install).toMatchObject({ package: "@acme/clock-widget", version: "1.0.0" });
  });

  it("lists featured packages and ranks similar ones by shared signals", async () => {
    expect((await client.listFeaturedPackages()).map((item) => item.name)).toEqual(["@acme/clock-widget"]);
    const similar = await client.findSimilarPackages("@acme/clock-widget");
    expect(similar[0]).toMatchObject({ package: { name: "@acme/timer-widget" } });
    expect(similar[0]?.reasons).toEqual(expect.arrayContaining(["keyword:time", "category:productivity", "kind:widget"]));
    expect(similar.map((entry) => entry.package.name)).not.toContain("@acme/clock-widget");
  });

  it("throws structured errors carrying the API code, status and request id", async () => {
    const missing = await client.getPackage("@acme/nope").catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(MarketplaceApiError);
    expect(missing).toMatchObject({ code: "not_found", status: 404 });
    expect((missing as MarketplaceApiError).requestId).toBeTruthy();

    await expect(client.me()).rejects.toMatchObject({ code: "unauthorized", status: 401 });
    await expect(createMarketplaceClient({ baseUrl: site.origin, fetch: site.fetch, token: "cmk_invalid" }).search({ q: "x" })).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("reports transport failures and rejects a non-HTTP base URL", async () => {
    const offline = createMarketplaceClient({
      baseUrl: site.origin,
      fetch: () => Promise.reject(new TypeError("connection refused")),
    });
    await expect(offline.health()).rejects.toMatchObject({ code: "network_error", status: 0 });
    expect(() => createMarketplaceClient({ baseUrl: "ftp://example.test" })).toThrow(MarketplaceApiError);
  });
});

describe("MarketplaceClient writes", () => {
  it("sends the bearer token and an idempotency key, so a replayed call is not applied twice", async () => {
    const token = await site.createToken(memberCookie, ["account:read", "packages:submit"]);
    const seen: Request[] = [];
    const client = createMarketplaceClient({
      baseUrl: site.origin,
      token: () => token,
      fetch: (request) => {
        seen.push(request.clone());
        return site.fetch(request);
      },
    });

    expect(await client.me()).toMatchObject({ email: MEMBER_EMAIL });
    const first = await client.submitPackage({ name: "@acme/notes-widget", version: "2.0.0" }, { idempotencyKey: `sdk-${suffix}` });
    const replay = await client.submitPackage({ name: "@acme/notes-widget", version: "2.0.0" }, { idempotencyKey: `sdk-${suffix}` });
    expect(first.created).toBe(true);
    expect(replay).toEqual(first);
    expect(site.sent.filter((message) => message.type === "index-package" && message.submissionId === first.submission.id)).toHaveLength(1);

    const generated = seen.filter((request) => request.method === "POST");
    expect(generated.every((request) => request.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
    expect(generated.map((request) => request.headers.get("idempotency-key"))).toEqual([`sdk-${suffix}`, `sdk-${suffix}`]);

    await client.submitPackage({ name: "@acme/other-widget" });
    expect(seen.at(-1)?.headers.get("idempotency-key")).toMatch(/^[0-9a-f-]{36}$/);
    expect((await client.getSubmission(first.submission.id)).id).toBe(first.submission.id);
  });

  it("publishes a page draft only for the expected revision", async () => {
    const client = createMarketplaceClient({ baseUrl: site.origin, fetch: site.fetch, token: await site.createToken(adminCookie, ["pages:read", "pages:write", "pages:publish"]) });
    const created = await client.raw.POST("/api/v1/admin/pages", {
      params: { header: {} },
      body: { slug: `sdk-${suffix}`, kind: "landing", title: "SDK landing" },
    });
    if (!created.data) throw new Error(`page creation failed: ${JSON.stringify(created.error)}`);
    const home = created.data.page;
    expect((await client.listPages()).map((page) => page.id)).toContain(home.id);
    const state = await client.getPage(home.id);

    const stale = await client.publishPage(home.id, "rev_stale").catch((error: unknown) => error);
    expect(stale).toMatchObject({ code: "conflict", status: 409 });

    const published = await client.publishPage(home.id, state.draft.revision.id);
    expect(published.published?.id).toBe(state.draft.revision.id);
    expect(published.page.publishedRevisionId).toBe(state.draft.revision.id);
  });

  it("denies admin operations to a member with a forbidden error", async () => {
    const client = createMarketplaceClient({ baseUrl: site.origin, fetch: site.fetch, token: await site.createToken(memberCookie, ["account:read"]) });
    await expect(client.featurePackage("@acme/timer-widget", true)).rejects.toMatchObject({ code: "forbidden", status: 403 });
  });
});

describe("device authorization", () => {
  it("rejects an unknown client and completes the flow after approval", async () => {
    await expect(requestDeviceCode({ baseUrl: site.origin, clientId: "unknown-client", fetch: site.fetch })).rejects.toBeInstanceOf(MarketplaceApiError);

    const code: DeviceCode = await requestDeviceCode({ baseUrl: site.origin, clientId: "clark-market-cli", fetch: site.fetch });
    expect(code.verificationUriComplete).toBe(`${site.origin}/device?user_code=${encodeURIComponent(code.userCode)}`);

    let polls = 0;
    const token = await pollDeviceToken({
      baseUrl: site.origin,
      clientId: "clark-market-cli",
      fetch: site.fetch,
      code,
      // Real waits at the server's interval: Better Auth rejects faster polling.
      sleep: async (ms) => {
        polls += 1;
        await new Promise((resolve) => setTimeout(resolve, ms));
        if (polls === 1) await site.approveDevice(code.userCode, memberCookie);
      },
    });
    expect(polls).toBe(1);
    const client = createMarketplaceClient({ baseUrl: site.origin, fetch: site.fetch, token: token.accessToken });
    expect(await client.me()).toMatchObject({ email: MEMBER_EMAIL });
  }, 20_000);

  it("waits longer on slow_down and surfaces access_denied", async () => {
    const answers = [
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 429, body: { message: "Too many requests" } },
      { status: 400, body: { error: "access_denied", error_description: "denied by the user" } },
    ];
    const waits: number[] = [];
    const polling = pollDeviceToken({
      baseUrl: site.origin,
      clientId: "clark-market-cli",
      fetch: async () => {
        const answer = answers.shift();
        if (!answer) throw new Error("polled too often");
        return Response.json(answer.body, { status: answer.status });
      },
      code: { deviceCode: "d", userCode: "U", verificationUri: "", verificationUriComplete: "", expiresIn: 600, interval: 5 },
      sleep: async (ms) => void waits.push(ms),
    });
    await expect(polling).rejects.toMatchObject({ code: "access_denied", message: "denied by the user" });
    expect(waits).toEqual([5000, 5000, 10000, 15000]);
  });

  it("stops when the signal aborts", async () => {
    const code = await requestDeviceCode({ baseUrl: site.origin, clientId: "clark-market-cli", fetch: site.fetch });
    const controller = new AbortController();
    const polling = pollDeviceToken({ baseUrl: site.origin, clientId: "clark-market-cli", fetch: site.fetch, code, signal: controller.signal });
    controller.abort(new Error("cancelled"));
    await expect(polling).rejects.toThrow("cancelled");
  });
});
