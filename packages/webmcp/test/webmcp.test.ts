import { createMarketplaceClient, type MarketplaceClient } from "@marketplace/sdk";
import { beforeAll, describe, expect, it } from "vitest";

import { resetDatabase, seedPackage, testDeps } from "../../marketplace/test/support/seed";
import { createInProcessSite } from "../../sdk/test/support/in-process-site";
import {
  detectModelContext,
  packagePageTools,
  pageBuilderTools,
  registerWebMcpTools,
  type BuilderSnapshot,
  type ModelContextLike,
  type WebMcpTool,
} from "../src";

const suffix = Date.now().toString(36);
const ADMIN_EMAIL = `webmcp-admin-${suffix}@example.test`;
const site = createInProcessSite({ adminEmails: [ADMIN_EMAIL] });

/** A stand-in for the browser's `ModelContext`: records registrations and honours the abort signal. */
class FakeModelContext implements ModelContextLike {
  readonly tools = new Map<string, WebMcpTool>();

  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }) {
    if (this.tools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`);
    this.tools.set(tool.name, tool);
    options?.signal?.addEventListener("abort", () => this.tools.delete(tool.name), { once: true });
  }

  async call(name: string, input: Record<string, unknown> = {}) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute(input);
  }
}

/** The browser sends the session cookie and its own Origin with same-origin API calls. */
function browserClient(cookie?: string): MarketplaceClient {
  return createMarketplaceClient({
    baseUrl: site.origin,
    fetch: (request) => {
      const headers = new Headers(request.headers);
      headers.set("origin", site.origin);
      if (cookie) headers.set("cookie", cookie);
      return site.fetch(new Request(request, { headers }));
    },
  });
}

let adminCookie = "";

beforeAll(async () => {
  const deps = testDeps();
  await resetDatabase(deps);
  await seedPackage(deps, {
    name: "@acme/clock-widget",
    description: "A tidy desk clock",
    keywords: ["clock", "time"],
    categorySlug: "productivity",
    publisher: { slug: "acme", name: "Acme" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  await seedPackage(deps, {
    name: "@tempo/timer-widget",
    description: "Counts down focus sessions",
    keywords: ["time"],
    categorySlug: "productivity",
    publisher: { slug: "tempo", name: "Tempo" },
    facets: [{ kind: "widget", isolation: "isolated-ui" }],
  });
  adminCookie = await site.signUp(ADMIN_EMAIL);
});

describe("registration", () => {
  it("detects document.modelContext first, then navigator.modelContext, else nothing", () => {
    const fromDocument = new FakeModelContext();
    const fromNavigator = new FakeModelContext();
    expect(detectModelContext({ document: { modelContext: fromDocument }, navigator: { modelContext: fromNavigator } })).toBe(fromDocument);
    expect(detectModelContext({ document: {}, navigator: { modelContext: fromNavigator } })).toBe(fromNavigator);
    expect(detectModelContext({ document: { modelContext: {} } })).toBeNull();
    expect(detectModelContext({})).toBeNull();
  });

  it("registers every tool until the signal aborts, and nothing without WebMCP", () => {
    const context = new FakeModelContext();
    const controller = new AbortController();
    const tools = packagePageTools({ client: browserClient(), packageName: "@acme/clock-widget" });
    expect(registerWebMcpTools(tools, { signal: controller.signal, modelContext: context })).toBe(6);
    expect([...context.tools.keys()].sort()).toEqual([
      "copy_package_reference",
      "find_similar_widgets",
      "get_current_package",
      "get_versions",
      "inspect_permissions",
      "open_in_clarkcant",
    ]);
    controller.abort();
    expect(context.tools.size).toBe(0);

    expect(registerWebMcpTools(tools, { signal: new AbortController().signal, modelContext: null })).toBe(0);
    expect(registerWebMcpTools(tools, { signal: AbortSignal.abort(), modelContext: new FakeModelContext() })).toBe(0);
  });

  it("unregisters through the returned handle when the implementation ignores the signal", () => {
    const unregistered: string[] = [];
    const legacy: ModelContextLike = {
      registerTool: (tool) => ({ unregister: () => unregistered.push(tool.name) }),
    };
    const controller = new AbortController();
    registerWebMcpTools(packagePageTools({ client: browserClient(), packageName: "x" }).slice(0, 2), { signal: controller.signal, modelContext: legacy });
    controller.abort();
    expect(unregistered).toEqual(["get_current_package", "get_versions"]);
  });
});

describe("package page tools", () => {
  const context = new FakeModelContext();
  const copied: string[] = [];

  beforeAll(() => {
    const tools = packagePageTools({
      client: browserClient(),
      packageName: "@acme/clock-widget",
      writeClipboard: async (text) => void copied.push(text),
    });
    registerWebMcpTools(tools, { signal: new AbortController().signal, modelContext: context });
  });

  it("reads the current package, versions, permissions and similar widgets", async () => {
    expect((await context.call("get_current_package")).structuredContent).toMatchObject({ name: "@acme/clock-widget" });
    expect((await context.call("get_versions")).structuredContent).toMatchObject({ items: [{ version: "1.0.0" }] });
    expect((await context.call("inspect_permissions")).structuredContent).toMatchObject({ package: "@acme/clock-widget", version: "1.0.0" });
    const similar = await context.call("find_similar_widgets", { limit: 3 });
    expect(similar.structuredContent).toMatchObject({ items: [{ package: { name: "@tempo/timer-widget" } }] });
    expect((await context.call("find_similar_widgets", { limit: 99 })).structuredContent).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("returns the deep link and coordinate without installing, and copies a reference", async () => {
    const opened = await context.call("open_in_clarkcant");
    expect(opened.structuredContent).toMatchObject({
      deepLink: "clarkcant://install?source=npm&package=%40acme%2Fclock-widget&version=1.0.0",
      coordinate: { package: "@acme/clock-widget", version: "1.0.0", source: "npm" },
    });
    expect((await context.call("copy_package_reference")).structuredContent).toEqual({ text: "@acme/clock-widget@1.0.0", copied: true });
    expect(copied).toEqual(["@acme/clock-widget@1.0.0"]);

    const missing = await context.call("open_in_clarkcant", { version: "9.9.9" });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ error: { code: "not_found" } });
  });
});

describe("page builder tools", () => {
  it("edits the draft through the admin API with the session, and refuses while the builder is dirty", async () => {
    const client = browserClient(adminCookie);
    const created = await client.raw.POST("/api/v1/admin/pages", {
      params: { header: {} },
      body: { slug: `webmcp-${suffix}`, kind: "landing", title: "WebMCP landing" },
    });
    if (!created.data) throw new Error(`page creation failed: ${JSON.stringify(created.error)}`);
    const pageId = created.data.page.id;

    const snapshot: BuilderSnapshot = { pageId, selectedBlockId: null, dirty: false };
    const changes: string[] = [];
    const context = new FakeModelContext();
    registerWebMcpTools(pageBuilderTools({ client, snapshot: () => snapshot, onDraftChanged: (id) => void changes.push(id), origin: site.origin }), {
      signal: new AbortController().signal,
      modelContext: context,
    });

    expect((await context.call("update_selected_block", { props: { title: "x" } })).structuredContent).toMatchObject({
      error: { code: "validation_failed", message: "no block is selected in the builder" },
    });

    const added = await context.call("add_block", { type: "hero", props: { title: "Made by an agent" } });
    expect(added.isError).toBeUndefined();
    const result = added.structuredContent as { draftRevisionId: string; results: { blockId: string }[] };
    expect(changes).toEqual([result.draftRevisionId]);

    snapshot.selectedBlockId = result.results[0]?.blockId ?? null;
    const updated = await context.call("update_selected_block", { props: { title: "Edited by an agent" } });
    expect(updated.isError).toBeUndefined();
    const page = await client.getPage(pageId);
    expect(JSON.stringify(page.draft.document.blocks)).toContain("Edited by an agent");

    snapshot.dirty = true;
    const refused = await context.call("add_block", { type: "hero" });
    expect(refused.structuredContent).toMatchObject({ error: { code: "validation_failed" } });
    expect(changes).toHaveLength(2);

    const invalid = await (async () => {
      snapshot.dirty = false;
      return context.call("add_block", { type: "no-such-block" });
    })();
    expect(invalid.isError).toBe(true);
    expect(invalid.structuredContent).toMatchObject({ error: { code: "validation_failed" } });
  });

  it("is denied to a visitor without an admin session", async () => {
    const context = new FakeModelContext();
    registerWebMcpTools(
      pageBuilderTools({ client: browserClient(), snapshot: () => ({ pageId: "pg_x", selectedBlockId: null, dirty: false }), origin: site.origin }),
      { signal: new AbortController().signal, modelContext: context },
    );
    expect((await context.call("add_block", { type: "hero" })).structuredContent).toMatchObject({ error: { code: "unauthorized" } });
  });
});
