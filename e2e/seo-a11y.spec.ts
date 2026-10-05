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
    expect(policy).toContain("script-src 'self' https://static.cloudflareinsights.com");
    expect(policy).toContain("connect-src 'self' https://cloudflareinsights.com");
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

  for (const path of ["/packages", "/collections"]) {
    test(`${path} has a Markdown twin, an alternate link and an ItemList`, async ({ request }) => {
      const twin = await request.get(`${path}.md`);
      expect(twin.status()).toBe(200);
      expect(twin.headers()["content-type"]).toContain("text/markdown");
      expect(twin.headers()["link"]).toMatch(new RegExp(`${path}>; rel="canonical"`));
      const body = await twin.text();
      expect(body).toMatch(/^# \S/);
      // A twin is read on its own, so it never links a bare site path.
      expect(body).not.toMatch(/\]\(\//);
      const html = await (await request.get(path)).text();
      expect(html).toMatch(new RegExp(`<link rel="alternate" type="text/markdown" href="[^"]+${path}\\.md"`));
      expect(jsonLdNodes(html).map((node) => node["@type"])).toEqual(expect.arrayContaining(["ItemList", "BreadcrumbList"]));
    });
  }

  test("filtered package listings are noindex and advertise no twin", async ({ request }) => {
    const html = await (await request.get("/packages?q=frame")).text();
    expect(html).toContain('content="noindex');
    expect(html).not.toContain('type="text/markdown"');
  });

  test("llms.txt stays fetchable but out of search results", async ({ request }) => {
    for (const path of ["/llms.txt", "/llms-full.txt"]) {
      const response = await request.get(path);
      expect(response.status()).toBe(200);
      expect(response.headers()["x-robots-tag"]).toBe("noindex");
    }
    const text = await (await request.get("/llms.txt")).text();
    expect(text).toMatch(/\]\(https?:\/\/\S+\/packages\.md\)/);
    expect(text).toMatch(/\]\(https?:\/\/\S+\/collections\.md\)/);
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
    expect(await bar.getByRole("link", { name: /Ask Perplexity/ }).getAttribute("href")).toMatch(/^https:\/\/www\.perplexity\.ai\/search\?q=/);
    // The Markdown copy leads, and the twin is one plain link away without JavaScript.
    await expect(bar.getByRole("button").first()).toHaveText("Copy as Markdown");
    expect(await bar.getByRole("link", { name: "View as Markdown" }).getAttribute("href")).toBe(`${path}.md`);

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

/** Stand-in site token, used only when the environment under test has no CF_WEB_ANALYTICS_TOKEN configured. */
const TEST_ANALYTICS_TOKEN = "0123456789abcdef0123456789abcdef";
const BEACON_SRC = "https://static.cloudflareinsights.com/beacon.min.js";
const CLOUDFLARE_INSIGHTS = /^https:\/\/(?:static\.)?cloudflareinsights\.com\//;

/**
 * Keeps Cloudflare Web Analytics off the network and makes sure every page under test has a site token. Requests to
 * the Cloudflare Insights origins are recorded: the beacon gets an empty stub script and reports are aborted. HTML
 * documents without a configured token get the stand-in token on the banner, the way the server renders a
 * configured one, so the client gating is exercised whatever the environment's configuration.
 */
async function interceptAnalytics(page: Page): Promise<{ requests: string[]; cspViolations: string[] }> {
  const requests: string[] = [];
  const cspViolations: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy/i.test(message.text())) cspViolations.push(message.text());
  });
  page.on("request", (request) => {
    if (CLOUDFLARE_INSIGHTS.test(request.url())) requests.push(request.url());
  });
  await page.route(CLOUDFLARE_INSIGHTS, (route) =>
    route.request().url().startsWith(BEACON_SRC)
      ? route.fulfill({ status: 200, contentType: "application/javascript", body: "/* beacon stub */" })
      : route.abort(),
  );
  await page.route("**/*", async (route) => {
    if (route.request().resourceType() !== "document") return route.fallback();
    const response = await route.fetch();
    const html = await response.text();
    const body = html.includes("data-analytics-token=")
      ? html
      : html.replace("data-consent-banner", `data-consent-banner data-analytics-token="${TEST_ANALYTICS_TOKEN}"`);
    // The body is decoded, so drop the encoding and length of the original response; the CSP header is kept.
    const headers = Object.fromEntries(
      Object.entries(response.headers()).filter(([name]) => name !== "content-encoding" && name !== "content-length"),
    );
    return route.fulfill({ status: response.status(), headers, body });
  });
  return { requests, cspViolations };
}

test.describe("cookie consent", () => {
  test("stores nothing before a choice and honours it afterwards", async ({ page, context }) => {
    await page.goto("/");
    expect(await context.cookies()).toEqual([]);
    const banner = page.getByRole("region", { name: "Cookies and storage" });
    await expect(banner).toBeVisible();

    await banner.getByRole("button", { name: "Essential only" }).click();
    await expect(banner).toBeHidden();
    expect((await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["cc_consent=v2.p0.a0"]);
    // Without preferences consent, a theme choice applies to this view only.
    await page.waitForLoadState("networkidle");
    await page.getByRole("button", { name: /^Theme:/ }).click();
    await expect(page.getByRole("button", { name: /^Theme: Light/ })).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBeNull();

    // Cookie settings reopens the banner with each category's current state.
    await page.getByRole("button", { name: "Cookie settings" }).click();
    const preferences = banner.getByRole("checkbox", { name: /Preferences/ });
    await expect(preferences).not.toBeChecked();
    await expect(banner.getByRole("checkbox", { name: /Analytics/ })).not.toBeChecked();
    await preferences.check();
    await banner.getByRole("button", { name: "Save choices" }).click();
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe("light");
    expect((await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["cc_consent=v2.p1.a0"]);
    await page.reload();
    await expect(banner).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  });

  test("Cloudflare Web Analytics loads only after opt-in and stops after withdrawal", async ({ page, context }) => {
    const { requests, cspViolations } = await interceptAnalytics(page);
    const beacon = page.locator(`script[src="${BEACON_SRC}"]`);
    const banner = page.getByRole("region", { name: "Cookies and storage" });

    // No choice yet: nothing loads.
    await page.goto("/", { waitUntil: "networkidle" });
    await expect(banner).toBeVisible();
    const token = (await page.locator("[data-consent-banner]").getAttribute("data-analytics-token")) ?? "";
    expect(token).not.toBe("");
    await expect(beacon).toHaveCount(0);

    // Essential only: still nothing, on this page or the next.
    await banner.getByRole("button", { name: "Essential only" }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(beacon).toHaveCount(0);
    expect(requests).toEqual([]);

    // Opt in to analytics alone: the beacon is added with the configured token, now and on later pages.
    await page.getByRole("button", { name: "Cookie settings" }).click();
    await banner.getByRole("checkbox", { name: /Analytics/ }).check();
    await banner.getByRole("button", { name: "Save choices" }).click();
    await expect(banner).toBeHidden();
    await expect(beacon).toHaveCount(1);
    expect(JSON.parse((await beacon.getAttribute("data-cf-beacon")) ?? "null")).toEqual({ token });
    expect((await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["cc_consent=v2.p0.a1"]);
    expect(requests).toContain(BEACON_SRC);
    await page.reload({ waitUntil: "networkidle" });
    await expect(beacon).toHaveCount(1);

    // Withdraw: the next page does not load it, and nothing reloads by itself.
    await page.getByRole("button", { name: "Cookie settings" }).click();
    await expect(banner.getByRole("checkbox", { name: /Analytics/ })).toBeChecked();
    await banner.getByRole("checkbox", { name: /Analytics/ }).uncheck();
    await banner.getByRole("button", { name: "Save choices" }).click();
    requests.length = 0;
    await page.reload({ waitUntil: "networkidle" });
    await expect(beacon).toHaveCount(0);
    expect(requests).toEqual([]);
    expect((await context.cookies()).map((cookie) => `${cookie.name}=${cookie.value}`)).toEqual(["cc_consent=v2.p0.a0"]);

    // Under a production build this also proves the policy allows the beacon and blocks nothing in either state.
    expect(cspViolations).toEqual([]);
  });

  test("with no site token configured nothing loads, even with analytics consent", async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (CLOUDFLARE_INSIGHTS.test(request.url())) requests.push(request.url());
    });
    await page.route(CLOUDFLARE_INSIGHTS, (route) => route.abort());
    await page.goto("/");
    const configured = await page.locator("[data-consent-banner]").getAttribute("data-analytics-token");
    test.skip(configured !== null, "This environment has CF_WEB_ANALYTICS_TOKEN configured");
    await page.getByRole("region", { name: "Cookies and storage" }).getByRole("button", { name: "Allow all" }).click();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator(`script[src="${BEACON_SRC}"]`)).toHaveCount(0);
    expect(requests).toEqual([]);
  });

  test("utility pages never offer the beacon a site token, whatever the consent", async ({ request }) => {
    const home = await (await request.get("/")).text();
    test.skip(!home.includes("data-analytics-token="), "This environment has no CF_WEB_ANALYTICS_TOKEN configured");
    // Preview paths carry a bearer token; Cloudflare Web Analytics records page paths.
    const preview = await request.get("/preview/not-a-real-token", { headers: { cookie: "cc_consent=v2.p0.a1" } });
    expect(await preview.text()).not.toContain("data-analytics-token=");
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

  test("the package listing reflows at 320px and applies a filter picked with a pointer", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await page.goto("/packages", { waitUntil: "networkidle" });
    await expectFitsWidth(page, 320);
    const category = page.getByLabel("Category");
    const slug = await category.locator("option").nth(1).getAttribute("value").catch(() => null);
    test.skip(!slug, "No categories to filter by");
    await category.click();
    await Promise.all([page.waitForURL(new RegExp(`/packages\\?.*category=${slug}`)), category.selectOption(slug ?? "")]);
    await expect(page.getByRole("link", { name: "Clear filters" })).toHaveAttribute("href", "/packages");
  });

  test("a filter changed from the keyboard does not navigate until applied", async ({ page }) => {
    await page.goto("/packages", { waitUntil: "networkidle" });
    const category = page.getByLabel("Category");
    const options = await category.locator("option").count();
    test.skip(options < 2, "No categories to filter by");
    let navigations = 0;
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    });
    await category.focus();
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(750);
    expect(navigations).toBe(0);
    await expect(page).toHaveURL(/\/packages$/);
    await expect(category).toBeFocused();
    await expect(page.getByText("press Enter or Search to apply")).toBeVisible();
  });

  test("footer links and buttons have at least a 24px target", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto("/");
    const footer = page.locator("footer");
    const sizes = await footer.locator("a, button").evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { name: element.textContent?.trim() ?? "", width: box.width, height: box.height };
      }),
    );
    expect(sizes.length).toBeGreaterThan(0);
    expect(sizes.filter((size) => size.height < 24 || size.width < 24)).toEqual([]);
  });

  test("cookie banner copy keeps its spacing and leaves most of a phone screen free", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/");
    const banner = page.getByRole("region", { name: "Cookies and storage" });
    await expect(banner).toBeVisible();
    await expect(banner).toContainText("Web Analytics. Cookie policy");
    expect((await banner.boundingBox())?.height ?? 999).toBeLessThanOrEqual(160);
  });

  test("interaction feedback is timed by tokens and stops under reduced motion", async ({ page }) => {
    await page.goto("/");
    const duration = () =>
      page.locator(".chrome-button, .consent-button").first().evaluate((element) => getComputedStyle(element).transitionDuration);
    expect(await duration()).not.toBe("0s");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect((await duration()).split(",").every((value) => value.trim() === "0s")).toBe(true);
  });

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
