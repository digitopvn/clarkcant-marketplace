import { MarketplaceError } from "@marketplace/contracts";
import { auditEvents, packages, packagesFts, publishers } from "@marketplace/db";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  acceptInvitation,
  addPublisherDomain,
  claimPackage,
  createPublisher,
  githubRepositoryFromUrl,
  inviteMember,
  linkPublisherRepository,
  listMyPublishers,
  listOwnedPackages,
  listPublisherInvitations,
  listPublisherMembers,
  verifyPublisherDomain,
  verifyPublisherRepository,
  type VerificationPorts,
} from "../src";
import { seedAccount, tokenActor, uniqueEmail } from "./support/accounts";
import { seedPackage, testDeps } from "./support/seed";

const deps = testDeps();

async function expectError(promise: Promise<unknown>, code: MarketplaceError["code"]) {
  await expect(promise).rejects.toSatisfy((error: unknown) => error instanceof MarketplaceError && error.code === code);
}

const uniqueSlug = (label: string) => `${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

/** Recorded lookups instead of live DNS/GitHub/npm: each test states exactly what the network would answer. */
function ports(answers: Partial<{ txt: string[]; file: string | null; maintainers: { name: string; email: string | null }[] | null }>) {
  const calls: string[] = [];
  const value: VerificationPorts = {
    resolveTxt: async (name) => (calls.push(`txt:${name}`), answers.txt ?? []),
    fetchRepositoryFile: async (_provider, repository, path) => (calls.push(`file:${repository}/${path}`), answers.file ?? null),
    fetchNpmMaintainers: async (name) => (calls.push(`npm:${name}`), answers.maintainers ?? null),
  };
  return { value, calls };
}

describe("publisher membership", () => {
  it("makes the creator owner and enforces unique slugs", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("pub-owner") });
    const slug = uniqueSlug("acme");
    const publisher = await createPublisher(deps, owner, { slug, name: "Acme" });
    expect(publisher).toMatchObject({ slug, role: "owner", kind: "org", verifiedAt: null });
    expect(await listMyPublishers(deps, owner)).toEqual([expect.objectContaining({ id: publisher.id, role: "owner" })]);
    await expectError(createPublisher(deps, owner, { slug, name: "Again" }), "conflict");
    await expectError(createPublisher(deps, owner, { slug: "Bad Slug", name: "x" }), "validation_failed");
  });

  it("lets owners invite, only invitees accept, and keeps members from managing", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("inv-owner") });
    const inviteeEmail = uniqueEmail("invitee");
    const invitee = await seedAccount(deps, { email: inviteeEmail });
    const stranger = await seedAccount(deps, { email: uniqueEmail("stranger") });
    const publisher = await createPublisher(deps, owner, { slug: uniqueSlug("team"), name: "Team" });

    const invitation = await inviteMember(deps, owner, publisher.id, { email: inviteeEmail.toUpperCase() });
    expect(invitation).toMatchObject({ email: inviteeEmail, role: "member", status: "pending" });
    expect((await inviteMember(deps, owner, publisher.id, { email: inviteeEmail })).id).toBe(invitation.id);
    expect(await listPublisherInvitations(deps, owner, publisher.id)).toHaveLength(1);

    await expectError(acceptInvitation(deps, stranger, invitation.id), "not_found");
    await expectError(listPublisherMembers(deps, stranger, publisher.id), "not_found");

    const joined = await acceptInvitation(deps, invitee, invitation.id);
    expect(joined.role).toBe("member");
    await expectError(acceptInvitation(deps, invitee, invitation.id), "conflict");
    expect((await listPublisherMembers(deps, invitee, publisher.id)).map((row) => row.role).sort()).toEqual(["member", "owner"]);

    await expectError(inviteMember(deps, invitee, publisher.id, { email: uniqueEmail("x") }), "forbidden");
    await expectError(addPublisherDomain(deps, invitee, publisher.id, { domain: "team.example" }), "forbidden");
    await expectError(inviteMember(deps, owner, publisher.id, { email: inviteeEmail }), "conflict");
  });

  it("lets only owners invite admins and lets marketplace admins manage any publisher", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("adm-owner") });
    const publisher = await createPublisher(deps, owner, { slug: uniqueSlug("adm"), name: "Adm" });
    const adminEmail = uniqueEmail("pub-admin");
    const pubAdmin = await seedAccount(deps, { email: adminEmail });
    const invite = await inviteMember(deps, owner, publisher.id, { email: adminEmail, role: "admin" });
    await acceptInvitation(deps, pubAdmin, invite.id);
    await expectError(inviteMember(deps, pubAdmin, publisher.id, { email: uniqueEmail("y"), role: "admin" }), "forbidden");
    await inviteMember(deps, pubAdmin, publisher.id, { email: uniqueEmail("z"), role: "member" });

    const marketplaceAdmin = await seedAccount(deps, { email: uniqueEmail("site-admin"), admin: true });
    expect(await listPublisherMembers(deps, marketplaceAdmin, publisher.id)).toHaveLength(2);
    await expectError(createPublisher(deps, tokenActor(owner, ["account:read"]), { slug: uniqueSlug("t"), name: "t" }), "forbidden");
  });
});

describe("publisher verification", () => {
  it("verifies a domain only when the TXT challenge is published", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("dns") });
    const publisher = await createPublisher(deps, owner, { slug: uniqueSlug("dns"), name: "Dns" });
    const domain = `${uniqueSlug("widgets")}.example`;
    const claim = await addPublisherDomain(deps, owner, publisher.id, { domain: domain.toUpperCase() });
    expect(claim).toMatchObject({ domain, txtRecordName: `_clarkcant-marketplace.${domain}`, verifiedAt: null });
    expect(claim.txtRecordValue).toMatch(/^clarkcant-marketplace-verification=[0-9a-f]{40}$/);

    const missing = ports({ txt: ["v=spf1 -all"] });
    await expectError(verifyPublisherDomain(deps, owner, publisher.id, claim.id, missing.value), "conflict");
    expect(missing.calls).toEqual([`txt:_clarkcant-marketplace.${domain}`]);

    const verified = await verifyPublisherDomain(deps, owner, publisher.id, claim.id, ports({ txt: [claim.txtRecordValue] }).value);
    expect(verified.verifiedAt).not.toBeNull();
    const [row] = await deps.db.select().from(publishers).where(eq(publishers.id, publisher.id));
    expect(row?.verifiedAt).not.toBeNull();

    const rival = await seedAccount(deps, { email: uniqueEmail("rival") });
    const rivalPublisher = await createPublisher(deps, rival, { slug: uniqueSlug("rival"), name: "Rival" });
    await expectError(addPublisherDomain(deps, rival, rivalPublisher.id, { domain }), "conflict");
  });

  it("verifies a repository through the committed verification file", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("repo") });
    const publisher = await createPublisher(deps, owner, { slug: uniqueSlug("repo"), name: "Repo" });
    const repo = `acme/${uniqueSlug("widget")}`;
    const link = await linkPublisherRepository(deps, owner, publisher.id, { repository: repo });
    expect(link.verificationFileContent).toBe(`clarkcant-marketplace-publisher=${publisher.id}`);

    await expectError(verifyPublisherRepository(deps, owner, publisher.id, link.id, ports({ file: null }).value), "conflict");
    const found = ports({ file: `# proof\n${link.verificationFileContent}\n` });
    const verified = await verifyPublisherRepository(deps, owner, publisher.id, link.id, found.value);
    expect(verified.verifiedAt).not.toBeNull();
    expect(found.calls).toEqual([`file:${repo}/.well-known/clarkcant-marketplace.txt`]);
  });
});

describe("package claims", () => {
  it("normalises npm repository URLs", () => {
    expect(githubRepositoryFromUrl("git+https://github.com/Acme/Chart-Widget.git")).toBe("acme/chart-widget");
    expect(githubRepositoryFromUrl("git@github.com:acme/chart.git")).toBe("acme/chart");
    expect(githubRepositoryFromUrl("github:acme/chart")).toBe("acme/chart");
    expect(githubRepositoryFromUrl("https://github.com/acme/chart/tree/main/packages/x")).toBe("acme/chart");
    expect(githubRepositoryFromUrl("https://gitlab.com/acme/chart")).toBeNull();
  });

  it("approves a claim proven by a verified repository and moves ownership to the publisher", async () => {
    const owner = await seedAccount(deps, { email: uniqueEmail("claim-repo") });
    const publisher = await createPublisher(deps, owner, { slug: uniqueSlug("claimer"), name: "Claimer" });
    const repo = `claimer/${uniqueSlug("chart")}`;
    const name = `@claimer/${uniqueSlug("chart")}`;
    const packageId = await seedPackage(deps, { name });
    await deps.db.update(packages).set({ repositoryUrl: `git+https://github.com/${repo}.git` }).where(eq(packages.id, packageId));

    const pending = await claimPackage(deps, owner, publisher.id, { packageName: name, method: "repository" }, ports({}).value);
    expect(pending).toMatchObject({ status: "pending", method: "repository", evidence: { matched: false } });

    const link = await linkPublisherRepository(deps, owner, publisher.id, { repository: repo });
    await verifyPublisherRepository(deps, owner, publisher.id, link.id, ports({ file: link.verificationFileContent }).value);
    const approved = await claimPackage(deps, owner, publisher.id, { packageName: name, method: "repository" }, ports({}).value);
    expect(approved).toMatchObject({ status: "approved", evidence: { method: "repository", matched: true, repository: repo } });

    const [listing] = await deps.db.select().from(packages).where(eq(packages.id, packageId));
    expect(listing).toMatchObject({ publisherId: publisher.id, verifiedPublisher: true });
    // The new publisher's name is searchable on the package right away.
    const [searchRow] = await deps.db.select({ publisher: packagesFts.publisher }).from(packagesFts).where(eq(packagesFts.packageId, packageId));
    expect(searchRow?.publisher).toContain("Claimer");
    expect(await listOwnedPackages(deps, owner)).toEqual([expect.objectContaining({ name, publisher: expect.objectContaining({ id: publisher.id }) })]);
    await expectError(claimPackage(deps, owner, publisher.id, { packageName: name, method: "repository" }, ports({}).value), "conflict");
    const audit = await deps.db.select().from(auditEvents).where(eq(auditEvents.subjectId, packageId));
    expect(audit.map((event) => event.action).sort()).toEqual(["package.claim_approved", "package.claim_requested"]);
  });

  it("approves npm-maintainer claims only for a verified matching email", async () => {
    const email = uniqueEmail("maint");
    const unverified = await seedAccount(deps, { email: uniqueEmail("unverified") });
    const verified = await seedAccount(deps, { email, emailVerified: true });
    const name = uniqueSlug("npm-widget");
    await seedPackage(deps, { name });

    const pubA = await createPublisher(deps, unverified, { slug: uniqueSlug("a"), name: "A" });
    await expectError(
      claimPackage(deps, unverified, pubA.id, { packageName: name, method: "npm_maintainer" }, ports({}).value),
      "forbidden",
    );

    const pubB = await createPublisher(deps, verified, { slug: uniqueSlug("b"), name: "B" });
    const noMatch = await claimPackage(
      deps, verified, pubB.id, { packageName: name, method: "npm_maintainer" },
      ports({ maintainers: [{ name: "someone", email: "someone@else.test" }] }).value,
    );
    expect(noMatch.status).toBe("pending");
    const lookups = ports({ maintainers: [{ name: "maint", email: email.toUpperCase() }] });
    const match = await claimPackage(deps, verified, pubB.id, { packageName: name, method: "npm_maintainer" }, lookups.value);
    expect(match).toMatchObject({ status: "approved", evidence: { matched: true, maintainer: "maint" } });
    expect(lookups.calls).toEqual([`npm:${name}`]);
    await expectError(
      claimPackage(deps, verified, pubB.id, { packageName: "not-indexed-xyz", method: "npm_maintainer" }, ports({}).value),
      "not_found",
    );
  });
});
