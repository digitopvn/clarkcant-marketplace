# Code review: web surface, agent clients, delivery

- Repo: clarkcant-marketplace, branch `dev`, HEAD `80c122c`. Date: 2026-09-29 (Asia/Saigon). This was a review only; no source files were changed.
- Scope: `apps/web/src` pages/components (not middleware, server or mcp), `astro.config.ts`, both `wrangler.jsonc`, `packages/{seo,sdk,webmcp}`, `apps/cli`, `.github/workflows/*`, root scripts, `e2e/`, and README/AGENTS/docs accuracy.
- Checks run: `pnpm vitest run packages/seo packages/webmcp packages/sdk` gave 4 files and 46 tests, all passing. A Node WHATWG-URL probe was run for the redirect finding. No dev servers were started.

## Findings

### 1. [major] Open redirect via `next` on /login and /signup (confidence: high)
- Files: `apps/web/src/components/auth/request.ts:63-65`, `apps/web/src/pages/login/index.astro:9,13`, `apps/web/src/pages/signup/index.astro:10`, `apps/web/src/components/auth/AuthForm.tsx:28`.
- Evidence: `safeNextPath` rejects only values that start with `//` or `/\`. `searchParams.get("next")` decodes `%09` to a TAB character, and the URL parser strips TAB/LF. Checked with `new URL("/\t/evil.com","https://mk.example").href`, which gives `https://evil.com/`. The same is true for `\n`.
- Impact: two cases.
  - A signed-in visitor opening `/login?next=/%09/evil.com` gets a 302 to evil.com.
  - An anonymous visitor is sent to evil.com by `window.location.assign` after signing in.
  - This is a phishing primitive on the auth origin. No test covers `safeNextPath`.
- Fix: parse and compare origins instead of checking prefixes. For example, `const u = new URL(next, "https://x.invalid"); if (u.origin !== "https://x.invalid") return fallback; return u.pathname + u.search + u.hash;`. Alternatively, reject any control character (`/[\u0000-\u001f\\]/`). Add unit cases for `\t`, `\n`, `/\`, `//` and `%2F%2F`.

### 2. [major] Preview workflow either never runs or exposes the deploy token to PR code (confidence: high on the mechanism; the outcome depends on where the secret is stored)
- File: `.github/workflows/preview.yml:23-24,51,58-59`. The job has no `environment:`.
- Evidence: `docs/deployment.md` and `README.md:86-88` say to store `CLOUDFLARE_API_TOKEN` per GitHub environment (`staging`/`production`). Environment secrets are not visible to a job without `environment:`, so the job always takes the "skipping" branch and previews never run.
- If the token is instead stored as a repo secret so previews work, two things follow:
  - Every same-repo PR branch runs `pnpm install` and `astro build` (PR-controlled `astro.config.ts` and lifecycle scripts) with that token in its environment.
  - The token is account-wide, per docs: "Workers, D1, R2, Queues edit rights". That bypasses the `production` environment protection rules.
  - `versions upload` then runs PR code against staging D1/R2 without applying the PR's migrations.
- Fix:
  - Add `environment: preview`, with a separate token scoped to the staging worker, not D1/R2 on production.
  - Pass the token only to the upload step, not to install/build.
  - Document the preview environment in `docs/deployment.md`.

### 3. [major] Deploy docs name `CLOUDFLARE_ACCOUNT_ID` as a secret, but workflows read a variable (confidence: high)
- Files: `docs/deployment.md:27` ("secret"), `README.md:86-87` ("secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`"), against `.github/workflows/deploy.yml:49` and `preview.yml:24` (`${{ vars.CLOUDFLARE_ACCOUNT_ID }}`).
- Impact: an operator who follows the docs gets a failed deploy at "Check deployment configuration" (`deploy.yml:64`), and previews are silently skipped.
- Fix: change both docs to "variable". The alternative, reading `secrets.` in the workflows, is not recommended because the account id is not sensitive.

### 4. [major] CSP and page-builder e2e never run in any pipeline, so the "critical paths" gate is partly phantom (confidence: high)
- Files: `e2e/seo-a11y.spec.ts:86,235` (skips unless `E2E_BUILT=1`) and `e2e/page-builder.spec.ts:11` (skips unless `E2E_ADMIN_EMAIL/PASSWORD` are set). Neither is set in `ci.yml`, `deploy.yml:34` or `deploy.yml:116`.
- Evidence: `astro.config.ts:34-37` says the hashed CSP is inactive under `astro dev`. Lines 16-21 there note that the style hashes are a workaround for Astro 7.3 not emitting runtime style hashes. `admin/pages/[id].astro` and `BaseLayout.astro` add inline-script hashes at runtime.
- Impact:
  - A CSP regression that blocks islands, the theme script or the builder canvas passes CI and ships to production.
  - The post-deploy staging run targets a real production build but still skips the CSP test.
  - The whole builder create/publish/rollback flow is untested in CI.
- Fix:
  - Set `E2E_BUILT=1` on the staging Playwright step (`deploy.yml:116`), since staging is a production build.
  - Add a built-preview e2e job in CI, or document that the gate does not cover this.
  - Provide staging admin e2e credentials as environment secrets, or remove the builder flow from the "critical paths" claim in the README.

### 5. [minor] Sitemap lists `/` even when the published home page is `noindex` (confidence: high)
- Files: `apps/web/src/server/site-index.ts:61` (outside the listed slice, but it feeds `sitemap-[segment].xml.ts`), and `pages/index.astro:38,53`.
- Evidence: `indexablePages()` first removes the noindex home entry. Then `!pages.some(p => p.path === "/")` is true, so the built-in `/` URL is pushed anyway. The page itself sends `X-Robots-Tag: noindex` and `<meta robots=noindex>`.
- Impact: a sitemap that contradicts the page's robots directive (Search Console "Submitted URL marked noindex").
- Fix: base the check on the unfiltered `listPublishedPages` result. Omit `/` when a published home page exists and has `noindex`.

### 6. [minor] The share bar's "Copy as Markdown" fails on any host other than `PUBLIC_SITE_URL` (confidence: medium)
- Files: `apps/web/src/components/share/ShareBar.astro:67-70,110` with `astro.config.ts:46` (`connect-src 'self'`).
- Evidence: `markdownUrl` is absolute and built from `PUBLIC_SITE_URL`, so the fetch is cross-origin on the PR preview alias host (`pr-N-…workers.dev`) or any secondary domain. CSP blocks it, and the user sees "That did not work here."
- Fix: fetch `new URL(markdownUrl).pathname` (same origin), and keep the absolute URL only for the copied text.

### 7. [minor] The CLI sends its bearer token to any `--api-url`, including plain `http://` (confidence: high)
- Files: `apps/cli/src/cli.ts:119-126` and `packages/sdk/src/client.ts` (`normalizeBaseUrl` accepts `http:`).
- Evidence: `CLARK_MARKET_TOKEN` takes precedence and is attached no matter which origin is chosen. A mistyped or hostile `--api-url`, or `CLARK_MARKET_API_URL` in CI, leaks a `cmk_` token. Plain-http origins other than localhost send it in clear text.
- Fix:
  - Refuse `http:` unless the host is `localhost` or `127.0.0.1`.
  - Consider binding `CLARK_MARKET_TOKEN` to the default or an explicitly confirmed origin, or at least print a warning to stderr when the origin is not the default.

### 8. [minor] The deploy job holds `contents: write` for every step (confidence: high)
- File: `.github/workflows/deploy.yml:45`. Only the production "Release marker" step needs write access, but `pnpm install` (third-party lifecycle scripts) and the build run with a write-capable `GITHUB_TOKEN` next to the Cloudflare token.
- Fix: move tagging into its own job (`needs: deploy`, `permissions: contents: write`) and set the deploy job to `contents: read`.

### 9. [minor] docs/cli.md: the `--json` contract is inaccurate for `login` (confidence: high)
- Files: `docs/cli.md:15` ("one JSON document per result") against `apps/cli/src/cli.ts:183,195`. `login --json` writes a `pending` document and then a `logged_in` document, so it emits two JSON lines.
- Fix: document the two-line output (a pending line, then the result) or drop the pending line in JSON mode.

## Checked areas with no findings (for calibration)
- JSON-LD: `jsonForScript` escapes `<`, U+2028 and U+2029, and the builders use `canonicalUrl`. The validator covers the emitted types.
- Markdown twins return the same canonical `Link` as the HTML pages. Scoped package paths are encoded consistently (`packagePath` and `decodeRouteParam`). The sitemap draws only from published and public queries. `PUBLIC_SITE_URL` has its trailing slash stripped by `runtimeVarsSchema`, so canonical URLs have no `//`.
- Robots: a full disallow outside production.
- Consent: the theme is read from and written to `localStorage` only when the `cc_consent=v1.p1` cookie is present. "Essential only" erases the stored value. The cookie uses SameSite=Lax and is Secure on https.
- Client XSS:
  - No `innerHTML` in islands.
  - The builder canvas is a `sandbox="allow-scripts"` srcdoc iframe with opaque origin, and message source identity is checked.
  - The share bar parses JSON defensively and writes only through `textContent`.
- Wrangler:
  - Names, D1 ids, R2, queue/DLQ, workflow `script_name` and rate-limit namespaces (1xxx/2xxx/3xxx) are consistent between web and jobs for each environment.
  - Observability is present in every web environment and inherited in jobs.
  - The jobs worker tolerates an absent `ADMIN_EMAILS` (schema default `""`).
- CLI token store: directory 0700, file 0600 re-chmod'ed, written through a temp file and atomic rename. Credentials are keyed by origin.
- SDK: every failure becomes `MarketplaceApiError`, including network and non-JSON responses. Device polling honours `slow_down`/429 and the deadline.
- Doc paths and `pnpm` commands referenced in README/AGENTS/docs all exist, including sibling `clarkcant/` paths.

## Recommended order
1 (open redirect), then 2 and 3 (CI secret model and docs), then 4 (enable the CSP e2e on staging), then 5-9.

## Unresolved questions
- Is `CLOUDFLARE_API_TOKEN` stored at repo level or per environment today? That decides whether finding 2 is "previews are dead" or "prod token exposed to PR builds".
- Is `wrangler d1 migrations … --env X` rejected, or silently re-targeted, when a local `.wrangler/deploy/config.json` redirect exists from a previous `CLOUDFLARE_ENV=… astro build`? `apps/web/wrangler.jsonc:4-5` says `--env` "is ignored". I could not inspect wrangler internals (node_modules access is blocked). If it is silently ignored, `pnpm db:migrate:production` after a local staging build would migrate the wrong database.

Status: DONE_WITH_CONCERNS
Summary: 9 verified findings. The main ones are an open redirect via TAB/LF in `next`, a preview-workflow secret model that either disables previews or exposes the account-wide deploy token to PR code, a docs/workflow mismatch on `CLOUDFLARE_ACCOUNT_ID`, and CSP/builder e2e that never run in any pipeline.
