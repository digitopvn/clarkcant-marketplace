import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";

import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";
import { createInProcessSite } from "../../sdk/test/support/in-process-site";
import {
  ADMIN_TOOLS,
  MAX_MCP_BODY_BYTES,
  MCP_PROTECTED_RESOURCE_METADATA_PATH,
  USER_TOOLS,
  handleMcpRequest,
  serveOAuthDiscovery,
  type DiscoveryDocument,
} from "../src";

const suffix = Date.now().toString(36);
const ADMIN_EMAIL = `mcp-admin-${suffix}@example.test`;
const MEMBER_EMAIL = `mcp-member-${suffix}@example.test`;
const PREVIEW_SECRET = `mcp-preview-${crypto.randomUUID()}`;
const site = createInProcessSite({ adminEmails: [ADMIN_EMAIL] });
const MCP_URL = `${site.origin}/mcp`;
// A 1×1 transparent PNG.
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const serveMcp = (request: Request) =>
  handleMcpRequest(request, {
    deps: site.deps(),
    vars: site.vars,
    resolveAuth: (incoming) => site.authFor(incoming),
    previewSecret: () => PREVIEW_SECRET,
  });

async function connect(token?: string): Promise<Client> {
  const client = new Client({ name: "marketplace-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
    fetch: (url, init) => serveMcp(new Request(url, init)),
    ...(token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {}),
  });
  await client.connect(transport);
  return client;
}

function rpc(method: string, params: unknown, headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
}

type ToolResult = Awaited<ReturnType<Client["callTool"]>>;
const structured = <T>(result: ToolResult) => result.structuredContent as T;

/** Tool-level failures are `isError` results; schema violations may instead surface as a thrown protocol error. */
async function expectToolFailure(client: Client, name: string, args: Record<string, unknown>, code?: string) {
  const outcome = await client.callTool({ name, arguments: args }).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  if ("error" in outcome) {
    expect(code === undefined || code === "validation_failed").toBe(true);
    return;
  }
  expect(outcome.result.isError).toBe(true);
  if (code) expect(structured<{ error: { code: string } }>(outcome.result).error.code).toBe(code);
}

let adminToken = "";
let memberToken = "";

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
    name: "@tempo/timer-widget",
    displayName: "Timer",
    description: "Counts down focus sessions",
    keywords: ["time", "focus"],
    categorySlug: "productivity",
    publisher: { slug: "tempo", name: "Tempo" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  const adminCookie = await site.signUp(ADMIN_EMAIL);
  const memberCookie = await site.signUp(MEMBER_EMAIL);
  adminToken = await site.createToken(adminCookie, [
    "account:read",
    "packages:submit",
    "packages:curate",
    "pages:read",
    "pages:write",
    "pages:publish",
    "media:write",
  ]);
  memberToken = await site.createToken(memberCookie, ["account:read", "packages:submit"]);
});

describe("tool listing", () => {
  const readTools = USER_TOOLS.filter((entry) => !entry.scope).map((entry) => entry.name).sort();

  it("offers anonymous callers the public read tools only", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((entry) => entry.name).sort()).toEqual(readTools);
    expect(tools.find((entry) => entry.name === "search_widgets")?.annotations?.readOnlyHint).toBe(true);
    await client.close();
  });

  it("adds the account tools for a member and every tool for an admin token", async () => {
    const member = await connect(memberToken);
    expect((await member.listTools()).tools.map((entry) => entry.name).sort()).toEqual(USER_TOOLS.map((entry) => entry.name).sort());
    await member.close();

    const admin = await connect(adminToken);
    const names = (await admin.listTools()).tools.map((entry) => entry.name).sort();
    expect(names).toEqual([...USER_TOOLS, ...ADMIN_TOOLS].map((entry) => entry.name).sort());
    await admin.close();
  });
});

describe("read tools", () => {
  it("answer valid input from the catalog and reject invalid input", async () => {
    const client = await connect();

    const search = await client.callTool({ name: "search_widgets", arguments: { query: "clock" } });
    expect(search.isError).toBeFalsy();
    expect(structured<{ items: { name: string }[] }>(search).items.map((item) => item.name)).toEqual(["@acme/clock-widget"]);
    await expectToolFailure(client, "search_widgets", { limit: 500 });

    const widget = await client.callTool({ name: "get_widget", arguments: { name: "@acme/clock-widget" } });
    expect(structured<{ name: string; latestVersion: string }>(widget)).toMatchObject({ name: "@acme/clock-widget", latestVersion: "1.0.0" });
    await expectToolFailure(client, "get_widget", { name: "@acme/missing" }, "not_found");

    const versions = await client.callTool({ name: "get_widget_versions", arguments: { name: "@acme/clock-widget" } });
    expect(structured<{ items: { version: string }[] }>(versions).items.map((item) => item.version)).toEqual(["1.0.0"]);
    await expectToolFailure(client, "get_widget_versions", { name: "Not A Name" }, "validation_failed");

    const permissions = await client.callTool({ name: "get_widget_permissions", arguments: { name: "@acme/clock-widget" } });
    expect(structured<{ package: string; version: string; permissions: unknown[] }>(permissions)).toMatchObject({
      package: "@acme/clock-widget",
      version: "1.0.0",
      permissions: expect.any(Array),
    });
    await expectToolFailure(client, "get_widget_permissions", { name: "@acme/missing" }, "not_found");

    const similar = await client.callTool({ name: "find_similar_widgets", arguments: { name: "@acme/clock-widget" } });
    expect(structured<{ items: { package: { name: string }; reasons: string[] }[] }>(similar).items[0]).toMatchObject({
      package: { name: "@tempo/timer-widget" },
    });
    await expectToolFailure(client, "find_similar_widgets", { name: "@acme/missing" }, "not_found");

    const featured = await client.callTool({ name: "list_featured_widgets", arguments: {} });
    expect(structured<{ items: { name: string }[] }>(featured).items.map((item) => item.name)).toEqual(["@acme/clock-widget"]);
    await expectToolFailure(client, "list_featured_widgets", { limit: 0 });

    await client.close();
  });
});

describe("authorization", () => {
  it("challenges an anonymous call to a scoped tool with resource metadata", async () => {
    const response = await serveMcp(rpc("tools/call", { name: "publish_page", arguments: { pageId: "pg_x", revisionId: "rev_x" } }));
    expect(response.status).toBe(401);
    const header = response.headers.get("www-authenticate") ?? "";
    expect(header).toContain(`resource_metadata="${site.origin}${MCP_PROTECTED_RESOURCE_METADATA_PATH}"`);
    expect(header).toContain('scope="pages:publish"');
  });

  it("answers 403 insufficient_scope for a member and 401 invalid_token for a bad bearer", async () => {
    const forbidden = await serveMcp(
      rpc("tools/call", { name: "feature_package", arguments: { name: "@acme/clock-widget", featured: true } }, { authorization: `Bearer ${memberToken}` }),
    );
    expect(forbidden.status).toBe(403);
    expect(forbidden.headers.get("www-authenticate")).toContain('error="insufficient_scope"');

    const invalid = await serveMcp(rpc("tools/list", {}, { authorization: "Bearer cmk_not_a_token" }));
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("rejects bodies over the cap with 413, declared or streamed, before any authentication", async () => {
    const oversized = new Uint8Array(MAX_MCP_BODY_BYTES + 1).fill(0x20);
    const declared = await serveMcp(
      new Request(MCP_URL, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cmk_not_a_token" }, body: oversized }),
    );
    expect(declared.status).toBe(413);
    expect(await declared.json()).toMatchObject({ error: "payload_too_large" });

    // A chunked body without Content-Length is counted while it is read.
    const chunk = new Uint8Array(1024 * 1024).fill(0x20);
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_MCP_BODY_BYTES) controller.close();
        else {
          sent += chunk.byteLength;
          controller.enqueue(chunk);
        }
      },
    });
    const streamed = await serveMcp(
      new Request(MCP_URL, { method: "POST", headers: { "content-type": "application/json" }, body: stream, duplex: "half" } as RequestInit),
    );
    expect(streamed.status).toBe(413);

    // A body under the cap still reaches the protocol handler.
    expect((await serveMcp(rpc("tools/list", {}))).status).toBe(200);
  });

  it("ignores browser session cookies, so a cross-site page cannot act as the visitor", async () => {
    const adminCookie = await site.signUp(`mcp-cookie-${suffix}@example.test`);
    const response = await serveMcp(rpc("tools/call", { name: "list_my_packages", arguments: {} }, { cookie: adminCookie }));
    expect(response.status).toBe(401);
  });
});

describe("account and admin tools", () => {
  it("submits a package and lists the member's packages", async () => {
    const client = await connect(memberToken);
    const submitted = await client.callTool({ name: "submit_package", arguments: { name: "@acme/notes-widget", version: "1.2.3" } });
    expect(structured<{ created: boolean; submission: { packageName: string } }>(submitted)).toMatchObject({
      created: true,
      submission: { packageName: "@acme/notes-widget" },
    });
    expect(site.sent.some((message) => message.type === "index-package" && message.packageName === "@acme/notes-widget")).toBe(true);
    const mine = await client.callTool({ name: "list_my_packages", arguments: {} });
    expect(mine.isError).toBeFalsy();
    expect(structured<{ items: unknown[] }>(mine).items).toEqual(expect.any(Array));
    await client.close();
  });

  it("edits, previews and publishes a page with revision checks", async () => {
    const created = await site.fetch(
      new Request(`${site.origin}/api/v1/admin/pages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
        body: JSON.stringify({ slug: `mcp-${suffix}`, kind: "landing", title: "MCP landing" }),
      }),
    );
    expect(created.status).toBe(201);
    const client = await connect(adminToken);

    const page = structured<{ page: { id: string }; draft: { revision: { id: string } } }>(
      await client.callTool({ name: "get_page", arguments: { page: `mcp-${suffix}` } }),
    );
    const patched = await client.callTool({
      name: "patch_page",
      arguments: {
        pageId: page.page.id,
        expectedRevisionId: page.draft.revision.id,
        operations: [{ op: "add_block", block: { type: "hero", props: { title: "Hello from MCP" } } }],
      },
    });
    expect(patched.isError).toBeFalsy();
    const draftId = structured<{ draft: { revision: { id: string } } }>(patched).draft.revision.id;

    await expectToolFailure(
      client,
      "patch_page",
      { pageId: page.page.id, expectedRevisionId: page.draft.revision.id, operations: [{ op: "set_page_seo", seo: { description: "stale" } }] },
      "conflict",
    );

    const preview = await client.callTool({ name: "preview_page", arguments: { pageId: page.page.id } });
    expect(structured<{ url: string }>(preview).url).toMatch(new RegExp(`^${site.origin}/`));

    await expectToolFailure(client, "publish_page", { pageId: page.page.id, revisionId: page.draft.revision.id }, "conflict");
    const published = await client.callTool({ name: "publish_page", arguments: { pageId: page.page.id, revisionId: draftId } });
    expect(structured<{ page: { publishedRevisionId: string } }>(published).page.publishedRevisionId).toBe(draftId);
    await client.close();
  });

  it("uploads images only and curates listings", async () => {
    const client = await connect(adminToken);
    const uploaded = await client.callTool({ name: "upload_media", arguments: { base64: PNG_BASE64, alt: "dot" } });
    expect(structured<{ contentType: string; url: string }>(uploaded)).toMatchObject({ contentType: "image/png" });
    await expectToolFailure(client, "upload_media", { base64: btoa("<svg onload=alert(1)>") }, "validation_failed");
    await expectToolFailure(client, "upload_media", { base64: "not base64 !!" }, "validation_failed");
    // Over 5 MiB once decoded: refused by the tool's input schema before any decoding.
    await expectToolFailure(client, "upload_media", { base64: "A".repeat(Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4) }, "validation_failed");

    const featured = await client.callTool({ name: "feature_package", arguments: { name: "@tempo/timer-widget", featured: true } });
    expect(structured<{ curationStatus: string }>(featured).curationStatus).toBe("featured");

    const collection = await client.callTool({
      name: "manage_collection",
      arguments: { slug: `picks-${suffix}`, command: { action: "create", title: "Picks" } },
    });
    expect(collection.isError).toBeFalsy();
    const added = await client.callTool({
      name: "manage_collection",
      arguments: { slug: `picks-${suffix}`, command: { action: "add_item", packageName: "@acme/clock-widget" } },
    });
    expect(JSON.stringify(added.structuredContent)).toContain("@acme/clock-widget");
    await client.close();
  });
});

describe("OAuth discovery", () => {
  const discover = (document: DiscoveryDocument, suffix?: string) =>
    serveOAuthDiscovery(document, suffix, new Request(`${site.origin}/.well-known/${document}${suffix ? `/${suffix}` : ""}`), {
      origin: site.origin,
      auth: () => site.authFor(new Request(`${site.origin}/`)),
    });

  it("names /mcp as the protected resource and Better Auth as its authorization server", async () => {
    for (const suffix of [undefined, "mcp"]) {
      const response = await discover("oauth-protected-resource", suffix);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        resource: `${site.origin}/mcp`,
        authorization_servers: [`${site.origin}/api/auth`],
        bearer_methods_supported: ["header"],
      });
    }
  });

  it("serves the authorization server and OpenID metadata at the root and issuer-suffixed paths", async () => {
    for (const suffix of [undefined, "api/auth"]) {
      const metadata = (await (await discover("oauth-authorization-server", suffix)).json()) as Record<string, unknown>;
      expect(metadata).toMatchObject({ issuer: `${site.origin}/api/auth` });
      expect(String(metadata.token_endpoint)).toContain("/api/auth/");
      expect(metadata.registration_endpoint).toBeTruthy();
      const openid = (await (await discover("openid-configuration", suffix)).json()) as Record<string, unknown>;
      expect(openid).toMatchObject({ issuer: `${site.origin}/api/auth` });
      expect(openid.jwks_uri).toBeTruthy();
    }
    expect((await discover("oauth-authorization-server", "elsewhere")).status).toBe(404);
  });
});
