import { expect, test, type Page } from "@playwright/test";

/*
 * Page builder flow: create, edit, preview, publish, public view, rollback. It needs an admin account: set
 * E2E_ADMIN_EMAIL (an address listed in ADMIN_EMAILS) and E2E_ADMIN_PASSWORD. The account is signed up on first use
 * and signed in afterwards. Outside development, admin also requires a verified email.
 */
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? "";
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? "";

test.skip(!ADMIN_EMAIL || !ADMIN_PASSWORD, "Set E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD for an ADMIN_EMAILS account");
// One shared account: running these in parallel would race its first sign-up.
test.describe.configure({ mode: "serial" });

async function signInAsAdmin(page: Page, baseURL: string) {
  const headers = { origin: new URL(baseURL).origin };
  const signIn = await page.request.post("/api/auth/sign-in/email", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD }, headers });
  if (signIn.ok()) return;
  const signUp = await page.request.post("/api/auth/sign-up/email", { data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: "E2E admin" }, headers });
  expect(signUp.ok(), `sign-up failed with ${signUp.status()}`).toBeTruthy();
}

async function setContent(page: Page, text: string) {
  const editor = page.getByLabel("Content (Markdown)");
  await editor.fill(text);
  // The canvas re-renders through the server renderer shortly after each edit.
  await expect(page.frameLocator('iframe[title^="Canvas preview"]').getByText(text)).toBeVisible();
}

test("create, preview, publish, view and roll back a page", async ({ page, baseURL }) => {
  test.slow();
  await signInAsAdmin(page, baseURL ?? "");
  const slug = `e2e-${Date.now().toString(36)}`;
  const first = `First version ${slug}`;
  const second = `Second version ${slug}`;

  await page.goto("/admin/pages");
  await expect(page.getByRole("heading", { name: "Pages", level: 1 })).toBeVisible();
  await page.getByLabel("Slug").fill(slug);
  await page.getByLabel("Title (optional)").fill("E2E page");
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(page).toHaveURL(/\/admin\/pages\/page_/);

  // Unpublished pages are not public.
  expect((await page.request.get(`/${slug}`)).status()).toBe(404);

  await page.getByRole("button", { name: "Rich text", exact: true }).click();
  await setContent(page, first);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as revision 2." })).toBeVisible();

  // Signed preview of the saved draft: renders, and is never indexed.
  await page.getByRole("button", { name: "Preview link" }).click();
  const previewUrl = await page.getByRole("link", { name: /\/preview\// }).getAttribute("href");
  expect(previewUrl).toBeTruthy();
  const preview = await page.request.get(previewUrl ?? "");
  expect(preview.status()).toBe(200);
  expect(preview.headers()["x-robots-tag"]).toContain("noindex");
  expect(await preview.text()).toContain(first);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published revision 2." })).toBeVisible();

  const publicPage = await page.context().newPage();
  await publicPage.goto(`/${slug}`);
  await expect(publicPage.getByText(first)).toBeVisible();
  const markdown = await page.request.get(`/api/v1/pages/${slug}?format=md`);
  expect(await markdown.text()).toContain(first);

  // A second published revision, then roll back to the first.
  await page.getByRole("treeitem").getByRole("button", { name: "Rich text", exact: true }).click();
  await setContent(page, second);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved as revision 3." })).toBeVisible();
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Published revision 3." })).toBeVisible();
  await publicPage.reload();
  await expect(publicPage.getByText(second)).toBeVisible();

  await page.getByRole("tab", { name: "Revisions" }).click();
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("listitem").filter({ hasText: "Revision 2" }).getByRole("button", { name: "Roll back to this" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Revision 2 is live again." })).toBeVisible();
  await publicPage.reload();
  await expect(publicPage.getByText(first)).toBeVisible();
  await publicPage.close();
});

test("the builder collapses into tabs at 375px", async ({ page, baseURL }) => {
  await signInAsAdmin(page, baseURL ?? "");
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/admin/pages");
  await page.getByLabel("Slug").fill(`e2e-mobile-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Create page" }).click();
  await expect(page).toHaveURL(/\/admin\/pages\/page_/);

  const tabs = page.getByRole("tablist", { name: "Builder panes" });
  await expect(tabs).toBeVisible();
  await expect(page.getByRole("region", { name: "Canvas" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Blocks" })).toBeHidden();

  await tabs.getByRole("tab", { name: "Blocks" }).click();
  await page.getByRole("button", { name: "Rich text", exact: true }).click();
  await tabs.getByRole("tab", { name: "Inspector" }).click();
  await expect(page.getByLabel("Content (Markdown)")).toBeVisible();
  // Every builder pane fits the viewport (the shared site header is outside the builder).
  for (const pane of [tabs, page.getByRole("complementary", { name: "Inspector" })]) {
    const box = await pane.boundingBox();
    expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(375);
  }
});
