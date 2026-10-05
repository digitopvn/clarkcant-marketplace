import type { PageDocumentInput } from "@marketplace/contracts";

/*
 * Policy pages every deployment starts with. They are ordinary page-builder documents (kind `legal`, docs/legal
 * layout), created and published through the page commands by `ensureDefaultPages`, so operators and their lawyers
 * edit them in the builder with full revision history.
 *
 * The text describes only what this codebase actually does. Facts nobody has decided yet (the operating legal
 * entity, its address, contact channels, governing law) are marked `[TO BE CONFIRMED: …]` instead of invented, and
 * every page opens with a draft notice until it has been reviewed.
 */

export const LEGAL_DRAFT_NOTICE =
  "> **Draft — requires legal review before production launch.** This text describes how the service works today. It is not final legal terms, and placeholders marked TO BE CONFIRMED still need an owner's decision.";

const OPERATOR = "[TO BE CONFIRMED: legal name and registered address of the operator]";
const PRIVACY_CONTACT = "[TO BE CONFIRMED: privacy contact email]";
const SECURITY_CONTACT = "[TO BE CONFIRMED: security contact email]";

export interface LegalPage {
  slug: string;
  document: PageDocumentInput;
}

function legalPage(slug: string, title: string, description: string, sections: readonly string[]): LegalPage {
  return {
    slug,
    document: {
      schemaVersion: 1,
      layout: { id: "docs-legal", version: 1 },
      meta: { title, description, locale: "en", noindex: false },
      blocks: [
        {
          id: `${slug}-body`,
          type: "rich-text",
          version: 1,
          props: { width: "prose", markdown: [LEGAL_DRAFT_NOTICE, ...sections].join("\n\n") },
        },
      ],
    },
  };
}

const TERMS = legalPage(
  "terms",
  "Terms of Service",
  "Draft terms for using the ClarkCant Marketplace: what the service does, what it does not do, and your responsibilities.",
  [
    "## Who runs the marketplace",
    `The ClarkCant Marketplace is operated by ${OPERATOR}.`,
    "## What the service is",
    "The marketplace **discovers, describes and curates** packages for ClarkCant. **npm distributes** those packages, and **ClarkCant installs and runs** them on your device after asking for your consent. The marketplace never hosts a package's code and never runs it.",
    "## Listings are not endorsements",
    "A listing shows what a package's author declared in its manifest and what our automated checks recorded when it was indexed. It does not grant the package any permission and does not mean its code is safe. See the [Security page](/security) for exactly what \"verified\", \"listed\" and \"featured\" mean.",
    "## Accounts",
    "- You are responsible for activity under your account and for keeping your sign-in methods, API tokens and linked devices secure.\n- You can export your data and delete your account at any time from [your account page](/account).\n- We may suspend accounts that abuse the service, for example by attacking it or by submitting packages that impersonate others.",
    "## Publishers and submissions",
    "- Only submit packages you are allowed to publish. The package's own licence governs its use; the marketplace adds no licence terms.\n- Curators may list, feature, hide or reject packages at their discretion. Hidden and rejected packages disappear from public pages and APIs.\n- Claims of package or domain ownership must be truthful; verification records are kept for audit.",
    "## Acceptable use",
    "Do not attempt to bypass rate limits, access other accounts, scrape the service in a way that degrades it for others, or use the APIs and agent interfaces to do anything you could not do through the website.",
    "## Paid services",
    "The marketplace has no paid transactions. See the [Refund Policy](/refunds).",
    "## Disclaimer and liability",
    "The service is provided as is. [TO BE CONFIRMED: warranty disclaimer, limitation of liability and governing law, to be written by counsel.]",
    "## Changes",
    "Material changes to these terms will be announced on this page with a new revision date before they take effect.",
  ],
);

const PRIVACY = legalPage(
  "privacy",
  "Privacy Policy",
  "Draft privacy policy: which personal data the ClarkCant Marketplace stores, why, for how long, and how to export or delete it.",
  [
    "## Controller",
    `${OPERATOR}. Privacy questions: ${PRIVACY_CONTACT}.`,
    "## What we store and why",
    "| Data | Why | Kept until |\n| --- | --- | --- |\n| Account: name, email, email-verified flag, profile image URL | To run your account | You delete the account |\n| Password (as a salted hash), passkeys (public keys only) | To sign you in | You remove them or delete the account |\n| Sessions: token, IP address, browser user agent | To keep you signed in and detect misuse | The session expires (7 days, extended while you use it) or you sign out |\n| GitHub sign-in link (only when GitHub sign-in is enabled): GitHub account id and OAuth tokens | To sign you in with GitHub | You delete the account |\n| API tokens (stored only as a SHA-256 hash), OAuth grants, linked ClarkCant devices | To let tools act for you with the scopes you chose | You revoke them or delete the account |\n| Publisher memberships, invitations, domain and repository verification records | To run publisher organisations | You leave the publisher or delete the account |\n| Package submissions and the audit log of changes you make | Accountability for changes to public content | [TO BE CONFIRMED: audit retention period] |\n| Rate-limit counters keyed by IP address and endpoint | To protect sign-in and the APIs from abuse | Overwritten within minutes to hours |\n| Request logs (request id, method, path, status, duration; no request bodies) | Operating and debugging the service | Cloudflare's log retention for the account [TO BE CONFIRMED] |",
    "Package listings themselves are public information published by package authors on npm.",
    "## What we do not do",
    "- No advertising and no tracking cookies.\n- Analytics only if you opt in: with your consent (the Analytics category in the [cookie settings](/cookies)) your browser loads Cloudflare Web Analytics, a privacy-friendly, cookieless service that counts page views. It sets no cookie, stores nothing on your device and does not build a profile of you; it receives the page address, referrer, browser user agent and your IP address as part of the request, and we see only aggregated page-view statistics. It is off by default and never runs before you opt in; withdrawing consent stops it from the next page.\n- We do not sell personal data.",
    "## Your controls",
    "- **Export:** download everything we hold about your account from [your account page](/account) or `GET /api/v1/me/export`.\n- **Delete:** delete your account from the account page or `DELETE /api/v1/me`. Sessions, tokens, OAuth grants, device links and media you uploaded that nothing else uses are removed. The audit log keeps only ids and counts for the deletion itself.\n- **Revoke:** revoke API tokens, OAuth grants and linked ClarkCant devices individually at any time.",
    "See [Your GDPR rights](/gdpr) for the full list of rights and how to exercise them, and [Subprocessors](/subprocessors) for who processes data for us.",
    "## Third-party content in your browser",
    "Pages load fonts from Google Fonts (fonts.googleapis.com, fonts.gstatic.com), and package README images are loaded from the jsDelivr CDN. Your browser contacts those services directly, which exposes your IP address to them. [TO BE CONFIRMED: whether to self-host fonts before launch.]",
  ],
);

const COOKIES = legalPage(
  "cookies",
  "Cookie Policy",
  "Draft cookie policy: the cookies and browser storage the ClarkCant Marketplace uses, by category, and how to change your choice.",
  [
    "## Categories",
    "- **Necessary** (always on): needed to sign in and keep the site secure.\n- **Preferences** (off until you allow it): remembers choices such as light or dark theme on this device.\n- **Analytics** (off until you allow it): privacy-friendly, cookieless Cloudflare Web Analytics that counts page views only. It sets no cookie and stores nothing on your device; the script runs only after you opt in.",
    "The marketplace runs **no advertising**. Any new category will be added here first, and nothing in it will run until you opt in.",
    "Non-essential categories are off by default. Change your choice at any time with **Cookie settings** in the site footer; withdrawing analytics consent stops it from the next page.",
    "## What is stored",
    "| Name | Category | Purpose | Lifetime |\n| --- | --- | --- | --- |\n| `better-auth.session_token` (with a `__Secure-` prefix on HTTPS) | Necessary | Keeps you signed in | 7 days, renewed while you use the site |\n| Short-lived sign-in cookies set by the authentication library (for example GitHub or passkey sign-in state) | Necessary | Protect a sign-in in progress | Minutes |\n| `cc_consent` | Necessary | Stores your cookie choice | 180 days |\n| `theme` (browser local storage) | Preferences | Remembers your theme choice | Until you clear it or withdraw consent |",
    "Signed-out visitors who only browse get no cookie until they make a cookie choice or sign in.",
    "## Third parties",
    "The site sets no third-party cookies. Fonts and README images come from Google Fonts and jsDelivr, and, only with analytics consent, the Cloudflare Web Analytics script comes from static.cloudflareinsights.com; see the [Privacy Policy](/privacy).",
  ],
);

const REFUNDS = legalPage(
  "refunds",
  "Refund Policy",
  "The ClarkCant Marketplace has no paid transactions, so there is nothing to refund.",
  [
    "## There are no paid transactions",
    "The marketplace does not sell anything today. Browsing, listing a package, publisher accounts and the APIs are free, and the marketplace never takes payment for a package. Packages are distributed by npm under their own licences.",
    "Because nothing is sold, there is nothing to refund.",
    "## If that changes",
    "If paid features are ever introduced, a refund policy covering them will be published on this page before the first payment is taken.",
  ],
);

const GDPR = legalPage(
  "gdpr",
  "Your GDPR rights",
  "Draft GDPR notice: your data protection rights for the ClarkCant Marketplace and the self-service tools to exercise them.",
  [
    "## Your rights",
    "If the EU or UK GDPR applies to you, you have the right to access, correct, delete, restrict and port your personal data, and to object to processing. Where processing relies on consent (remembering your theme preference, cookieless analytics), you can withdraw consent at any time.",
    "## Self-service",
    "| Right | How |\n| --- | --- |\n| Access and portability | Export as JSON from [your account page](/account) or `GET /api/v1/me/export` |\n| Rectification | Profile editing is not in the account page yet; contact us (below) |\n| Erasure | Delete your account on the account page or `DELETE /api/v1/me` |\n| Withdraw consent | **Cookie settings** in the site footer |\n| Revoke access you gave to tools | Revoke API tokens, OAuth grants and linked devices on the account page |",
    `For anything the tools do not cover, contact ${PRIVACY_CONTACT}. We answer within one month.`,
    "## Legal bases",
    "- Contract: running your account and the features you use.\n- Legitimate interests: security, abuse prevention (rate limits, audit log) and operating the service.\n- Consent: storing preferences such as your theme on your device, and counting page views with Cloudflare Web Analytics.",
    "## Transfers",
    "The service runs on Cloudflare's global network, so data may be processed outside your country. [TO BE CONFIRMED: transfer mechanism, for example the Cloudflare Data Processing Addendum with Standard Contractual Clauses.]",
    "## Complaints",
    "You can complain to your local data protection authority. [TO BE CONFIRMED: lead supervisory authority, if any.]",
  ],
);

const SECURITY = legalPage(
  "security",
  "Security",
  "How the ClarkCant Marketplace handles package trust: the security boundary, what verified, listed and featured mean, and how to report a vulnerability.",
  [
    "## The boundary",
    "- **The marketplace discovers and curates.** It indexes package metadata from npm, records automated checks and shows curation decisions.\n- **npm distributes.** Package tarballs, versions and integrity digests come from npm. The marketplace never hosts or serves package code.\n- **ClarkCant executes.** ClarkCant downloads the exact version from npm, re-verifies its integrity, shows the permissions the manifest requests, asks for your consent and runs the package in its declared isolation lane.",
    "Nothing on the marketplace grants a package any permission, and the marketplace never runs community code, not even to render a preview: previews are images, video and metadata only.",
    "## What the words mean",
    "| Term | Meaning | What it does **not** mean |\n| --- | --- | --- |\n| **Listed** | The package passed automated checks when indexed: a valid ClarkCant manifest and a tarball that matched npm's sha512 integrity digest | A person has reviewed the code, or the code is safe |\n| **Featured** | Marketplace curators chose to highlight the package | A security audit |\n| **Hidden / rejected** | Curators removed the package from public pages and APIs | Anything about other versions or other registries |\n| **Verified publisher** | The publisher proved control of a web domain with a DNS TXT record | That the publisher's packages are safe or reviewed |\n| **Tarball integrity** | The tarball we downloaded matched the sha512 digest npm publishes | That the code is benign; ClarkCant checks integrity again itself |\n| **Provenance recorded** | npm lists a provenance attestation; we store its reference | A verified signature: the marketplace does not verify attestations yet |",
    "Package listing data is untrusted input written by package authors. READMEs and descriptions are sanitised before display and scripts in them never run.",
    "## How the site protects you",
    "- A strict Content Security Policy, framing only by the site itself, and no third-party scripts except Cloudflare Web Analytics, which loads only after you opt in to analytics.\n- Rate limits on sign-in, the APIs, search and package submission.\n- Every admin and curator change is validated against schemas, needs a scoped credential and is written to an audit log. Agents and tools use scoped tokens; nothing gets direct database access.",
    "## Reporting a vulnerability",
    `Please report vulnerabilities privately to ${SECURITY_CONTACT} and allow us time to fix them before disclosure. Do not test against other people's accounts or data.`,
  ],
);

const SUBPROCESSORS = legalPage(
  "subprocessors",
  "Subprocessors",
  "Draft list of the third parties that process data for the ClarkCant Marketplace, and the external services it depends on.",
  [
    "## Subprocessors",
    "| Provider | What they do for us | Data involved |\n| --- | --- | --- |\n| Cloudflare, Inc. | Hosting (Workers), database (D1), file storage (R2), background jobs (Queues, Workflows), request logs, and Web Analytics (only for visitors who opt in) | All service data, including account data and request logs; for analytics, page views without cookies |\n| GitHub, Inc. | Sign in with GitHub, only when GitHub sign-in is enabled | Your GitHub account id, profile and email, exchanged when you choose GitHub sign-in |",
    "## Data sources (not subprocessors)",
    "| Service | Use | Personal data sent |\n| --- | --- | --- |\n| npm registry (registry.npmjs.org) | Source of package metadata, tarballs and integrity digests for indexing | None; the marketplace fetches public package data |\n| Cloudflare DNS over HTTPS (cloudflare-dns.com) | Looks up TXT records when a publisher verifies a domain | The domain name being verified |\n| GitHub (raw.githubusercontent.com) | Reads a verification file when a publisher links a repository | The repository name |",
    "## Loaded by your browser",
    "Google Fonts serves the site's fonts and jsDelivr serves images referenced by package READMEs. Your browser requests them directly; see the [Privacy Policy](/privacy).",
    "Changes to this list will be published here before a new subprocessor starts processing personal data. [TO BE CONFIRMED: notification channel for customers.]",
  ],
);

export const LEGAL_PAGES: readonly LegalPage[] = [TERMS, PRIVACY, COOKIES, REFUNDS, GDPR, SECURITY, SUBPROCESSORS];
