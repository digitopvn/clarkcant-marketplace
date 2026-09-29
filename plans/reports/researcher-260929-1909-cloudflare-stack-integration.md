# Cloudflare Workers stack integration (verified 2026-09-29)

**Bottom line:** the stack works on Workers, but four of the latest npm releases must not be used. Pin **Vitest 4.1.x**, because both Workers test packages require `vitest ^4.1.0` and Vitest 5 is not supported. Pin **TypeScript 6.0.x**, because `@astrojs/check` 0.9.10 requires `typescript ^5 || ^6`. Use **`@modelcontextprotocol/server` v2**, not `@modelcontextprotocol/sdk` 1.x; v2 is the stable line. Import Better Auth's **OIDC provider** from `@better-auth/oauth-provider`, because `oidcProvider` and `mcp` no longer ship in `better-auth/plugins` 1.7.6. Also note that `Astro.locals.runtime` has been removed and the Astro adapter no longer supports Pages.
## 1. Versions (`npm view <pkg> version`, 2026-09-29)
| pkg | latest | use | pkg | latest | use |
|---|---|---|---|---|---|
| astro | 7.3.5 | 7.3.5 (node >=22.12) | better-auth | 1.7.6 | 1.7.6 |
| @astrojs/cloudflare | 14.3.3 | peer astro ^7.2, wrangler ^4.125 | @better-auth/passkey / oauth-provider | 1.7.6 | same train |
| @astrojs/react | 7.0.0 | 7.0.0 | auth (Better Auth CLI; `@better-auth/cli` stale at 1.4.22) | 1.7.6 | `npx auth generate` |
| tailwindcss / @tailwindcss/vite | 4.3.3 | 4.3.3 (vite ^8 ok) | @modelcontextprotocol/sdk | 1.31.0 | **avoid (v1)** |
| hono | 4.13.11 | 4.13.11 | @modelcontextprotocol/server | 2.2.0 | **use** (zod ^4.2) |
| @hono/zod-openapi | 1.6.3 | peer zod ^4, hono >=4.10 | agents (McpAgent) | 0.24.0 | alternative only |
| zod | 4.6.5 | 4.6.5 (better-auth deps zod ^4.5.4) | wrangler | 4.143.0 | 4.143.0 |
| drizzle-orm / drizzle-kit | 0.45.3 / 0.31.11 | stay on these, not 1.0 rc | vitest | **5.0.2** | **4.1.11** |
| @cloudflare/vitest-pool-workers | 0.22.0 | peer vitest ^4.1 | @cloudflare/vitest-plugin | 1.3.1 | newer, peer vitest ^4.1 |
| @playwright/test | 1.63.0 | 1.63.0 | typescript | **7.0.2** | **6.0.3** |
| unified/remark-parse/remark-rehype/rehype-sanitize/rehype-stringify | 11.0.5/11.0.0/11.1.2/6.0.0/10.0.1 | Markdown sanitizer | marked | 18.0.14 | skip: it does not sanitize |
| citty | 0.2.2 | CLI (small, ESM) | commander | 15.0.0 | also fine |
Zod: use a single `zod@4.6.5`. @hono/zod-openapi 1.x, Better Auth, and MCP server v2 all require Zod 4. MCP v2 imports `zod/v4`, and that subpath is provided by zod 4.

## 2. Astro 7 on Workers (`@astrojs/cloudflare` 14)
Source: https://docs.astro.build/en/guides/integrations-guide/cloudflare/ and the adapter source (`dist/wrangler.js`).
- Pages deploys are no longer supported, so this is Workers only. `astro dev` runs in **workerd** through `@cloudflare/vite-plugin`, so `platformProxy` is no longer used. The `workerEntryPoint` option has also been removed.
- A Wrangler config is optional because the adapter fills in defaults: `main: "@astrojs/cloudflare/entrypoints/server"`, `assets.binding: "ASSETS"`, and a `compatibility_date`. It also auto-adds `kv_namespaces:[{binding:"SESSION"}]` and `images:{binding:"IMAGES"}`. Set `session: false` in the Astro config, or declare these bindings yourself, to avoid provisioning resources you don't use.
- **Bindings:** `import { env } from "cloudflare:workers"`. `Astro.locals.runtime` has been removed. For `waitUntil`, use `Astro.locals.cfContext`, and read `cf` from `Astro.request.cf`.
- **Environments:** these are chosen at **build time**: `CLOUDFLARE_ENV=staging astro build && wrangler deploy`. The build writes a flattened `wrangler.json`, and passing `--env` to `wrangler deploy` has no effect (https://developers.cloudflare.com/workers/vite-plugin/reference/cloudflare-environments/).
- Tailwind v4: add `vite: { plugins: [tailwindcss()] }` and `@import "tailwindcss";` in the global CSS. Add `integrations: [react()]`.

```ts
// apps/web/src/pages/api/[...path].ts  -- Hono under /api/*
import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { app } from "../../server/api"; // new OpenAPIHono<{ Bindings: Env }>().basePath("/api")
export const prerender = false;
export const ALL: APIRoute = ({ request, locals }) => app.fetch(request, env, locals.cfContext);
```
```ts
// server/api.ts  (@hono/zod-openapi 1.x)
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
export const app = new OpenAPIHono<{ Bindings: Env }>().basePath("/api");
app.openapi(createRoute({ method: "get", path: "/health",
  responses: { 200: { description: "ok", content: { "application/json": { schema: z.object({ ok: z.boolean() }) } } } } }),
  (c) => c.json({ ok: true }, 200));
app.doc31("/openapi.json", { openapi: "3.1.0", info: { title: "API", version: "1" } });
```
`hono-openapi` 1.3.3 (Standard Schema) is a valid alternative. I rank `@hono/zod-openapi` first because it is first-party (honojs/middleware) and route-typed.

## 3. Drizzle + D1 (https://orm.drizzle.team/docs/connect-cloudflare-d1)
```ts
// drizzle.config.ts (repo root)
import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "sqlite", schema: "./packages/db/src/schema/*.ts", out: "./migrations" });
// runtime: import { drizzle } from "drizzle-orm/d1"; const db = drizzle(env.DB, { schema });
```
wrangler: `"d1_databases":[{"binding":"DB","database_name":"app-staging","database_id":"…","migrations_dir":"../../migrations"}]`. Flow: `drizzle-kit generate` then `wrangler d1 migrations apply app-staging --env staging --remote` (use `--local` for dev). drizzle-kit 0.31 writes flat `NNNN_name.sql` files, which Wrangler reads. The Drizzle **1.0 rc** changes the output layout, so stay on 0.x until wrangler compatibility with it is verified.

## 4. Better Auth 1.7.6 on Workers
- Requires `compatibility_flags: ["nodejs_compat"]`; without it you get "Buffer is not defined" (https://github.com/better-auth/better-auth/issues/1375). Create the instance per request, because a module singleton would capture a stale D1 binding (discussion #7963).
- Plugins: `organization` and `deviceAuthorization` come from `better-auth/plugins` (both confirmed in the 1.7.6 exports). Import `passkey` from `@better-auth/passkey` and `oauthProvider` from `@better-auth/oauth-provider`. `oauthProvider` is the OAuth 2.1/OIDC server; it **replaces** `oidcProvider`/`mcp`, and **requires `jwt()`** plus `loginPage`/`consentPage` (https://www.better-auth.com/docs/plugins/oauth-provider).
```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, deviceAuthorization, jwt } from "better-auth/plugins";
import { passkey } from "@better-auth/passkey";
import { oauthProvider } from "@better-auth/oauth-provider";
export const createAuth = (env: Env) => betterAuth({
  baseURL: env.BETTER_AUTH_URL, secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(drizzle(env.DB, { schema }), { provider: "sqlite", schema }),
  emailAndPassword: { enabled: true },
  socialProviders: { github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET } },
  plugins: [organization(), passkey(), deviceAuthorization(), jwt(),
    oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" })],
});
// Hono: app.on(["GET","POST"], "/auth/*", (c) => createAuth(c.env).handler(c.req.raw));
```
Schema: `npx auth generate --config ./packages/auth/src/cli-config.ts --output ./packages/db/src/schema/auth.ts`, then `drizzle-kit generate`. The CLI needs a config it can import from Node, so give it a stub env and don't import `cloudflare:workers` there. Watch CPU time: email+password uses scrypt in JS, so check the paid Workers CPU limits.

## 5. MCP: stateless on a Worker (https://ts.sdk.modelcontextprotocol.io/v2/serving/http)
```ts
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
const mcp = createMcpHandler(({ authInfo }) => {           // factory runs once per HTTP request
  const s = new McpServer({ name: "marketplace", version: "1.0.0" });
  s.registerTool("search", { description: "Search listings", inputSchema: z.object({ q: z.string() }) },
    async ({ q }) => ({ content: [{ type: "text", text: `results for ${q}` }] }));
  return s;
}); // options: { legacy: "stateless" (default: 2025 clients get stateless; GET/DELETE -> 405) | "reject" }
app.all("/mcp", (c) => mcp.fetch(c.req.raw /*, { authInfo } */));
```
`WebStandardStreamableHTTPServerTransport` is still exported for manual wiring, and `@modelcontextprotocol/hono` 2.0.1 is an optional adapter. Using `createMcpHandler` is simplest (KISS). Cloudflare's `agents` 0.24 `McpAgent` is Durable Object-backed and stateful. It adds a DO binding and migrations and ties you to Cloudflare, so use it only if you need sessions, elicitation or server push. For auth, validate Better Auth oauth-provider tokens and pass them as `authInfo`.

## 6. apps/jobs: Queue consumer + Workflow, bound from apps/web
Sources: https://developers.cloudflare.com/workflows/build/workers-api/ and https://developers.cloudflare.com/queues/configuration/configure-queues/
```jsonc
// apps/jobs/wrangler.jsonc  (worker name per env = "<name>-<env>" -> jobs-staging)
{ "name": "jobs", "main": "src/index.ts", "compatibility_date": "2026-09-01", "compatibility_flags": ["nodejs_compat"],
  "env": { "staging": {
    "d1_databases": [{ "binding": "DB", "database_name": "app-staging", "database_id": "…" }],
    "queues": { "consumers": [{ "queue": "jobs-staging", "max_batch_size": 10, "max_retries": 3, "dead_letter_queue": "jobs-dlq-staging" }] },
    "workflows": [{ "name": "ingest-staging", "binding": "INGEST", "class_name": "IngestWorkflow" }] },
  "production": { /* same keys, *-production resources */ } } }
```
```ts
// apps/jobs/src/index.ts
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
export class IngestWorkflow extends WorkflowEntrypoint<Env, { id: string }> {
  async run(e: WorkflowEvent<{ id: string }>, step: WorkflowStep) { await step.do("fetch", async () => ({ ok: e.payload.id })); } }
export default { async queue(batch, env) { for (const m of batch.messages) { /* … */ m.ack(); } } } satisfies ExportedHandler<Env>;
```
```jsonc
// apps/web/wrangler.jsonc  env.staging (bindings are NON-inheritable: repeat vars/d1/r2/queues/workflows per env)
"queues": { "producers": [{ "binding": "JOBS", "queue": "jobs-staging" }] },
"workflows": [{ "name": "ingest-staging", "binding": "INGEST", "class_name": "IngestWorkflow", "script_name": "jobs-staging" }],
"r2_buckets": [{ "binding": "FILES", "bucket_name": "files-staging" }]
// usage: await env.JOBS.send({...}); await env.INGEST.create({ id, params: { id } });
```
Deploy `jobs` first so that `script_name` resolves. Note that `script_name` is the *env-suffixed* worker name.

## 7. Testing (https://developers.cloudflare.com/workers/testing/vitest-integration/)
- Current docs use `@cloudflare/vitest-plugin` 1.3.1: `plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })]` with `vitest/config`. Import `env`/`exports` from `cloudflare:workers`. `@cloudflare/vitest-pool-workers` 0.22.0 still ships `readD1Migrations`/`applyD1Migrations`; confirm the plugin re-exports them before switching. **Both packages require Vitest ^4.1.**
- Test pure domain logic (packages/domain) with plain Node Vitest 4.1.11, and run a Vitest workspace/projects split. Use Playwright 1.63 against `astro preview`, which runs in workerd.

## 8. WebMCP (W3C CG draft dated 2026-09-29, https://webmachinelearning.github.io/webmcp/)
The spec now uses `document.modelContext`. Chrome deprecated `navigator.modelContext` in 150 and plans to remove it in 153. The Chrome origin trial covers 149–156 and ends 2026-11-16. There is no `provideContext` or `unregisterTool`; to unregister a tool, abort its `signal`.
```ts
const mc = (document as any).modelContext ?? (navigator as any).modelContext; // alias only for OT builds
if (mc?.registerTool) {
  const ac = new AbortController();
  await mc.registerTool({ name: "search_listings", description: "Search the marketplace",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    annotations: { readOnlyHint: true },
    execute: async ({ q }, { signal }) => fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal }).then(r => r.json()) },
    { signal: ac.signal }); // registerTool rejects if the name already exists
}
```

## 9. Incompatibilities and flags
1. Vitest 5 won't work with the Workers test packages; pin 4.1.11. TypeScript 7 won't work with `@astrojs/check`; pin 6.0.3. The MCP v2 README also says TS >=6 needs `"types":["node"]`.
2. Add `nodejs_compat` to **both** workers. Better Auth, and Astro's ALS usage, depend on it; without it the adapter only injects `nodejs_als`.
3. The adapter auto-adds SESSION KV and IMAGES bindings. In an environment block these are non-inheritable, so declare them per env or disable them.
4. `wrangler deploy --env` is ignored for apps/web because the env is fixed by `CLOUDFLARE_ENV` at build. apps/jobs, a plain Worker, still uses `--env`.
5. Don't use `@better-auth/cli` (it is stale); the CLI package is now `auth`. `oidcProvider` and `mcp` imports from `better-auth/plugins` no longer exist.
6. `@modelcontextprotocol/sdk` 1.x pulls in express, cors and `@hono/node-server`; v2 `@modelcontextprotocol/server` has a `workerd` shim export.
7. For Markdown, use remark-parse → remark-rehype → rehype-sanitize → rehype-stringify. It is pure JS and needs no DOM. Avoid DOMPurify, which needs a DOM, and avoid marked on its own, which does not sanitize.
Sources: npm (live) + URLs above; https://developers.cloudflare.com/workers/wrangler/environments/ ; https://www.spronta.com/blog/state-of-webmcp-july-2026/ ; https://modelpiper.com/blog/webmcp-chrome-api-migration-mocked-tests

## Unresolved questions
- Local dev for cross-worker Workflow and Queue bindings under `astro dev` (Vite plugin) versus a separate `wrangler dev` for jobs: I did not verify that the dev registry supports Workflows across scripts.
- I did not verify whether `@cloudflare/vitest-plugin` 1.3.1 exports `applyD1Migrations`.
- I have not confirmed the exact `npx auth generate` flags for 1.7.6 against the CLI `--help`.
