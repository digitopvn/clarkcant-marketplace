import { AUTH_BASE_PATH, createAuthRuntime } from "@marketplace/auth";
import { parseRuntimeVars, type IngestMessage } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";
import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";

const ORIGIN = "http://localhost:4325";
const SECRET = `catalog-test-${crypto.randomUUID()}-${crypto.randomUUID()}`;
const suffix = Date.now().toString(36);
const ADMIN_EMAIL = `curator-${suffix}@example.test`;
const MEMBER_EMAIL = `member-${suffix}@example.test`;
const vars = parseRuntimeVars({ PUBLIC_SITE_URL: ORIGIN, ENVIRONMENT: "development", ADMIN_EMAILS: ADMIN_EMAIL });

const sent: IngestMessage[] = [];
// Structural double of the queue producer: the API only calls `send`.
const queue = { send: async (message: IngestMessage) => void sent.push(message) } as unknown as Queue<IngestMessage>;
const deps = () => createMarketplaceDeps({ d1: env.DB, media: env.MEDIA, queue });
const authFor = (request: Request) =>
  createAuthRuntime({ deps: deps(), vars, secrets: { BETTER_AUTH_SECRET: SECRET }, request });
const api = createApi({ resolveContext: () => ({ deps: deps(), vars }), resolveAuth: (request) => authFor(request) });

const call = (path: string, init: RequestInit = {}) => api.request(`${ORIGIN}${path}`, init);
const post = (path: string, body: unknown, cookie: string, headers: Record<string, string> = {}) =>
  call(path, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, cookie, ...headers },
    body: JSON.stringify(body),
  });

async function signUp(email: string): Promise<string> {
  const request = new Request(`${ORIGIN}${AUTH_BASE_PATH}/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: "correct horse battery", name: email.split("@")[0] }),
  });
  const response = await authFor(request).auth.handler(request);
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0] ?? "")
    .find((entry) => entry.startsWith("better-auth.session_token="));
  if (!cookie) throw new Error("sign-up returned no session cookie");
  return cookie;
}

let curator = "";
let member = "";

beforeAll(async () => {
  const seedDeps = testDeps();
  await resetDatabase(seedDeps);
  await seedPackage(seedDeps, {
    name: "@acme/clock-widget",
    description: "A tidy desk clock",
    categorySlug: "productivity",
    publisher: { slug: "acme", name: "Acme" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  curator = await signUp(ADMIN_EMAIL);
  member = await signUp(MEMBER_EMAIL);
});

describe("package read API", () => {
  it("filters listings and serves versions and the install coordinate", async () => {
    const filtered = await call("/api/v1/packages?publisher=acme&isolation=isolated-ui&curation=listed");
    expect(await filtered.json()).toMatchObject({ items: [{ name: "@acme/clock-widget" }] });
    expect(await (await call("/api/v1/packages?isolation=service")).json()).toMatchObject({ items: [] });
    expect((await call("/api/v1/packages?curation=hidden")).status).toBe(400);

    const versions = await call("/api/v1/packages/%40acme%2Fclock-widget/versions");
    expect(await versions.json()).toMatchObject({ items: [{ version: "1.0.0", npmIntegrity: "sha512-test" }] });

    const install = await call("/api/v1/packages/%40acme%2Fclock-widget/install");
    expect(install.status).toBe(200);
    expect(await install.json()).toEqual({
      package: "@acme/clock-widget",
      version: "1.0.0",
      source: "npm",
      integrity: "sha512-test",
      openInClarkCant: "clarkcant://install?source=npm&package=%40acme%2Fclock-widget&version=1.0.0",
      cliCommand: "npm pack @acme/clock-widget@1.0.0",
      // A seeded version with a manifest ClarkCant cannot read, never measured.
      packageId: null,
      contentDigest: null,
      sizeBytes: null,
    });
    expect((await call("/api/v1/packages/%40acme%2Fclock-widget/install?version=2.0.0")).status).toBe(404);
    expect((await call("/api/v1/packages/%40acme%2Fclock-widget/install?version=latest")).status).toBe(400);
  });
});

describe("submission API", () => {
  it("requires a signed-in account", async () => {
    const response = await call("/api/v1/publish/submit", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "clock-widget" }),
    });
    expect(response.status).toBe(401);
  });

  it("accepts a submission, queues it once and reports its status to the submitter only", async () => {
    const first = await post("/api/v1/publish/submit", { name: "@acme/notes-widget", version: "1.0.0" }, member, {
      "idempotency-key": "submit-notes-1",
    });
    expect(first.status).toBe(202);
    const body = (await first.json()) as { submission: { id: string; status: string }; created: boolean };
    expect(body).toMatchObject({ created: true, submission: { status: "queued", packageName: "@acme/notes-widget" } });
    expect(sent).toEqual([{ type: "index-package", submissionId: body.submission.id, packageName: "@acme/notes-widget" }]);

    const replay = await post("/api/v1/publish/submit", { name: "@acme/notes-widget", version: "1.0.0" }, member, {
      "idempotency-key": "submit-notes-1",
    });
    expect(await replay.json()).toEqual(body);
    const duplicate = await post("/api/v1/publish/submit", { name: "@acme/notes-widget", version: "1.0.0" }, member);
    expect(await duplicate.json()).toMatchObject({ created: false, submission: { id: body.submission.id } });
    expect(sent).toHaveLength(1);

    const status = await call(`/api/v1/publish/submissions/${body.submission.id}`, { headers: { cookie: member } });
    expect(status.status).toBe(200);
    expect(status.headers.get("cache-control")).toContain("no-store");
    expect(await status.json()).toMatchObject({ id: body.submission.id, status: "queued" });
    expect((await call(`/api/v1/publish/submissions/${body.submission.id}`)).status).toBe(401);
    expect((await call(`/api/v1/publish/submissions/${body.submission.id}`, { headers: { cookie: curator } })).status).toBe(200);
  });

  it("rejects invalid names and cross-site cookie posts", async () => {
    expect((await post("/api/v1/publish/submit", { name: "Bad Name!" }, member)).status).toBe(400);
    const crossSite = await call("/api/v1/publish/submit", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", cookie: member },
      body: JSON.stringify({ name: "clock-widget" }),
    });
    expect(crossSite.status).toBe(403);
  });
});

describe("curation API", () => {
  it("lets curators feature, hide and collect packages, and nobody else", async () => {
    expect((await post("/api/v1/curation/packages/%40acme%2Fclock-widget/featured", { featured: true }, member)).status).toBe(403);

    const featured = await post("/api/v1/curation/packages/%40acme%2Fclock-widget/featured", { featured: true }, curator);
    expect(await featured.json()).toEqual({ name: "@acme/clock-widget", curationStatus: "featured" });
    expect(await (await call("/api/v1/packages?curation=featured")).json()).toMatchObject({
      items: [{ name: "@acme/clock-widget" }],
    });

    expect(
      (await post("/api/v1/curation/collections/desk-picks", { action: "create", title: "Desk picks", published: true }, curator)).status,
    ).toBe(200);
    const added = await post(
      "/api/v1/curation/collections/desk-picks",
      { action: "add_item", packageName: "@acme/clock-widget", note: "Start here" },
      curator,
    );
    expect(await added.json()).toMatchObject({ items: [{ packageName: "@acme/clock-widget", note: "Start here" }] });
    expect(await (await call("/api/v1/collections/desk-picks")).json()).toMatchObject({
      packages: [{ name: "@acme/clock-widget" }],
    });

    const hidden = await post(
      "/api/v1/curation/packages/%40acme%2Fclock-widget/status",
      { status: "hidden", reason: "broken entry" },
      curator,
    );
    expect(await hidden.json()).toEqual({ name: "@acme/clock-widget", curationStatus: "hidden" });
    expect((await call("/api/v1/packages/%40acme%2Fclock-widget")).status).toBe(404);
    expect(await (await call("/api/v1/collections/desk-picks")).json()).toMatchObject({ packages: [] });
    const state = await call("/api/v1/curation/collections/desk-picks", { headers: { cookie: curator } });
    expect(await state.json()).toMatchObject({ items: [{ packageName: "@acme/clock-widget" }] });

    const conflict = await post("/api/v1/curation/packages/%40acme%2Fclock-widget/featured", { featured: true }, curator);
    expect(conflict.status).toBe(409);
    const badCommand = await post("/api/v1/curation/collections/desk-picks", { action: "explode" }, curator);
    expect(badCommand.status).toBe(400);
  });

  it("documents every new route in OpenAPI", async () => {
    const document = (await (await call("/openapi.json")).json()) as { paths: Record<string, unknown> };
    expect(Object.keys(document.paths)).toEqual(
      expect.arrayContaining([
        "/api/v1/packages/{name}/versions",
        "/api/v1/packages/{name}/install",
        "/api/v1/publish/submit",
        "/api/v1/publish/submissions/{id}",
        "/api/v1/curation/packages/{name}/status",
        "/api/v1/curation/packages/{name}/featured",
        "/api/v1/curation/collections/{slug}",
      ]),
    );
  });
});
