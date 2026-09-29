/// <reference lib="dom" />
// page.evaluate callbacks run in the browser.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

/*
 * Machine-readable surfaces, security headers, accessibility and layout budgets on the public pages.
 *
 * Package and builder-page checks need data: index the fixture package first (`pnpm index:local`) and publish at
 * least one page (the admin "Create default pages" button). Tests that find no such data skip with a reason.
 *
 * Checks that only hold for a production build (the hashed CSP, the JavaScript budget) run when E2E_BUILT=1,
 * for example against `astro preview` or a deployed environment through BASE_URL.
 */
const BUILT = process.env.E2E_BUILT === "1";
/** JavaScript a public page may load (bytes as served). Public pages ship small DOM scripts only: theme, share, consent. */
const JS_BUDGET_BYTES = 120 * 1024;

async function locs(request: APIRequestContext, sitemapPath: string): Promise<string[]> {
  const response = await request.get(sitemapPath);
  if (!response.ok()) return [];
  return [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1] ?? "");
}

/** Site-relative path of a sitemap URL (sitemaps use PUBLIC_SITE_URL, which may differ from the test host). */
function pathOf(loc: string): string {
  const url = new URL(loc.replaceAll("&amp;", "&"));
  return url.pathname + url.search;
}

async function firstPackagePath(request: APIRequestContext): Promise<string | null> {
  const [loc] = await locs(request, "/sitemap-packages-1.xml");
  return loc ? pathOf(loc) : null;
}

async function firstBuilderPagePath(request: APIRequestContext): Promise<string | null> {
  const builtIn = new Set(["/", "/packages", "/collections"]);
  const loc = (await locs(request, "/sitemap-pages.xml")).map(pathOf).find((path) => !builtIn.has(path));
  return loc ?? null;
}

async function expectNoSeriousA11yViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    // Dev-server tooling is not part of the site.
    .exclude("astro-dev-toolbar")
    .exclude("vite-error-overlay")
    .analyze();
  const serious = results.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical");
  expect(serious.map((violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function expectFitsWidth(page: Page, width: number) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `page is ${overflow}px wider than a ${width}px viewport`).toBeLessThanOrEqual(0);
}

function jsonLdNodes(html: string): Record<string, unknown>[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((match) => {
    const value: unknown = JSON.parse(match[1] ?? "null");
    return (Array.isArray(value) ? value : [value]) as Record<string, unknown>[];
  });
}

test.describe("security headers", () => {
  test("HTML pages forbid framing and sniffing and carry a request id", async ({ request }) => {
    const response = await request.get("/");
    const headers = response.headers();
    expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(headers["content-security-policy"]).toContain("object-src 'none'");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["permissions-policy"]).toContain("camera=()");
    expect(headers["x-request-id"]).toMatch(/^[A-Za-z0-9._-]{8,128}$/);
    if (new URL(response.url()).protocol === "https:") expect(headers["strict-transport-security"]).toContain("max-age=");
  });

  test("API responses are locked down too and echo a caller request id", async ({ request }) => {
    const response = await request.get("/api/v1/health", { headers: { "x-request-id": "e2e-trace-0001" } });
    expect(response.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(response.headers()["x-request-id"]).toBe("e2e-trace-0001");
  });

  test("the built site ships a hashed script/style policy and runs without CSP violations", async ({ page }) => {
    test.skip(!BUILT, "Astro emits the hashed CSP only in production builds (set E2E_BUILT=1)");
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/Content Security Policy/i.test(message.text())) violations.push(message.text());
    });
    const response = await page.goto("/");
    // Astro delivers the hashed policy as a header on this adapter (a <meta> tag elsewhere); accept either.
    const meta = await page.locator('meta[http-equiv="content-security-policy" i]').getAttribute("content", { timeout: 1_000 }).catch(() => null);
    const policy = meta ?? response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).toMatch(/sha256-/);
    expect(response?.headers()["content-security-policy"]).toContain("frame-ancestors 'none'");
    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });
});

test.describe("machine-readable surfaces", () => {
  test("robots.txt names the sitemap and keeps private paths out", async ({ request }) => {
    const text = await (await request.get("/robots.txt")).text();
    expect(text).toMatch(/Sitemap: https?:\/\/\S+\/sitemap\.xml/);
    // Local and staging hosts disallow everything; production allows all but private paths.
    expect(text.includes("Disallow: /\n") || text.includes("Disallow: /admin\n")).toBe(true);
  });

  test("the sitemap index lists segments that all resolve", async ({ request }) => {
    const response = await request.get("/sitemap.xml");
    expect(response.headers()["content-type"]).toContain("application/xml");
    const segments = await locs(request, "/sitemap.xml");
    expect(segments.map((loc) => new URL(loc).pathname)).toEqual(expect.arrayContaining(["/sitemap-pages.xml", "/sitemap-packages-1.xml"]));
    for (const segment of segments) expect((await request.get(pathOf(segment))).status()).toBe(200);
    expect((await request.get("/sitemap-users.xml")).status()).toBe(404);
    const pages = (await locs(request, "/sitemap-pages.xml")).map(pathOf);
    expect(pages).toEqual(expect.arrayContaining(["/", "/packages"]));
  });

  test("llms.txt follows the llms.txt layout and links Markdown twins", async ({ request }) => {
    const text = await (await request.get("/llms.txt")).text();
    expect(text.startsWith("# ClarkCant Marketplace\n\n> ")).toBe(true);
    expect(text).toContain("## Start here");
    expect(text).toMatch(/\]\(https?:\/\/\S+\/index\.md\)/);
    expect(text).toContain('"listed" means a package passed automated checks');
    const full = await request.get("/llms-full.txt");
    expect(full.status()).toBe(200);
    expect(await full.text()).toContain("# ClarkCant Marketplace");
  });

  test("the home page twin is Markdown and points back to the HTML page", async ({ request }) => {
    const response = await request.get("/index.md");
    expect(response.headers()["content-type"]).toContain("text/markdown");
    expect(response.headers()["link"]).toMatch(/rel="canonical"/);
    // Built-in landing or a published builder "home" page; either way a Markdown document with a top heading.
    expect(await response.text()).toMatch(/^# \S/m);
  });

  test("a builder page twin equals the page engine's Markdown for the live revision", async ({ request }) => {
    const path = await firstBuilderPagePath(request);
    test.skip(!path, "No published builder page (use the admin 'Create default pages' button)");
    const slug = (path ?? "").slice(1);
    const twin = await request.get(`${path}.md`);
    expect(twin.status()).toBe(200);
    const api = await request.get(`/api/v1/pages/${slug}?format=md`);
    expect(await twin.text()).toBe(await api.text());
    // The HTML page advertises the twin in its head and in a Link header.
    const html = await request.get(path ?? "/");
    expect(html.headers()["link"]).toContain(`${path}.md>; rel="alternate"; type="text/markdown"`);
  });

  test("a package page exposes canonical, Open Graph, JSON-LD and a Markdown twin", async ({ request }) => {
    const path = await firstPackagePath(request);
    test.skip(!path, "No indexed package (run `pnpm index:local`)");
    const html = await (await request.get(path ?? "/")).text();
    expect(html).toContain(`<link rel="canonical" href="`);
    expect(html).toMatch(/<link rel="alternate" type="text\/markdown" href="[^"]+\.md"/);
    expect(html).toMatch(/<meta property="og:image" content="https?:\/\/[^"]+\.png"/);
    const types = jsonLdNodes(html).map((node) => node["@type"]);
    expect(types).toEqual(expect.arrayContaining(["SoftwareSourceCode", "BreadcrumbList"]));
    const twin = await request.get(`${path}.md`);
    expect(twin.status()).toBe(200);
    expect(await twin.text()).toContain("## Install");
  });
});

test.describe("share bar", () => {
  test("prefills assistants with the encoded prompt and copies the canonical and Markdown URLs", async ({ page, context, request }) => {
    const path = await firstBuilderPagePath(request);
    test.skip(!path, "No published builder page (use the admin 'Create default pages' button)");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto(path ?? "/");
    const bar = page.locator("[data-share-bar]");
    const chatgpt = await bar.getByRole("link", { name: /Ask ChatGPT/ }).getAttribute("href");
    const prompt = new URL(chatgpt ?? "").searchParams.get("q") ?? "";
    expect(prompt).toMatch(/\.md \(web page: https?:\/\//);
    expect(await bar.getByRole("link", { name: /Ask Claude/ }).getAttribute("href")).toMatch(/^https:\/\/claude\.ai\/new\?q=/);

    await bar.getByRole("button", { name: "Copy URL" }).click();
    await expect(bar.getByRole("status")).toHaveText("Page URL and Markdown URL copied.");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    // Windows clipboards store line breaks as CRLF.
    expect(copied).toMatch(/^https?:\/\/\S+\r?\nMarkdown: https?:\/\/\S+\.md$/);

    // The twin is fetched from the page's own origin, so it works on preview and secondary hosts under connect-src 'self'.
    const twinRequest = page.waitForRequest((request) => new URL(request.url()).pathname.endsWith(".md"));
    await bar.getByRole("button", { name: "Copy as Markdown" }).click();
    expect(new URL((await twinRequest).url()).origin).toBe(new URL(page.url()).origin);
    await expect(bar.getByRole("status")).toHaveText("Page copied as Markdown.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^# /m);
  });
});

test.describe("cookie consent", () => {
  test("stores nothing before a choice and honours it afterwards", async ({ page, context }) => {
    await page.goto("/");
    expect(await context.cookies()).toEqual([]);
    const banner = page.getByRole("region", { name: "Cookies and storage" });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Essential only" }).click();
    await expect(banner).toBeHidden();
    expect((await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["cc_consent=v1.p0"]);
    // Without preferences consent, a theme choice applies to this view only.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await expect(page.getByRole("button", { name: /^Theme: Light/ })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();

    await page.getByRole("button", { name: "Cookie settings" }).click();
    await banner.getByRole("button", { name: "Allow preferences" }).click();
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("light");
    await page.reload();
    await expect(banner).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  });
});

test.describe("accessibility and layout", () => {
  const routes: [string, (request: APIRequestContext) => Promise<string | null>][] = [
    ["home", async () => "/"],
    ["package", firstPackagePath],
    ["builder page", firstBuilderPagePath],
    // Policy pages carry tables, the widest content on the site.
    ["policy page", async (request) => ((await request.get("/subprocessors")).ok() ? "/subprocessors" : null)],
  ];

  for (const [name, resolve] of routes) {
    test(`${name}: no serious axe violations and no horizontal overflow at 375px`, async ({ page, request }) => {
      const path = await resolve(request);
      test.skip(!path, `No ${name} to check (see the notes at the top of this file)`);
      await page.setViewportSize({ width: 375, height: 800 });
      await page.goto(path ?? "/");
      await expectFitsWidth(page, 375);
      await expectNoSeriousA11yViolations(page);
    });
  }

  test("public pages stay within the JavaScript budget", async ({ page }) => {
    test.skip(!BUILT, "Dev servers ship unbundled modules; measure a production build (E2E_BUILT=1)");
    let bytes = 0;
    page.on("response", async (response) => {
      if (response.request().resourceType() !== "script") return;
      const length = Number(response.headers()["content-length"] ?? 0);
      bytes += length > 0 ? length : (await response.body()).byteLength;
    });
    await page.goto("/", { waitUntil: "networkidle" });
    expect(bytes).toBeLessThanOrEqual(JS_BUDGET_BYTES);
  });
});
