import { canonicalUrl } from "./site";

/** Paths that are private, per-user or transient; crawlers are asked to skip them. */
export const ROBOTS_DISALLOWED_PATHS = ["/admin", "/api/", "/preview/", "/account", "/login", "/signup", "/device", "/oauth/"] as const;

export interface RobotsInput {
  siteUrl: string;
  /** False on staging and development: the whole host is disallowed so test copies never compete in search. */
  allowIndexing: boolean;
}

export function renderRobotsTxt(input: RobotsInput): string {
  const lines = input.allowIndexing
    ? ["User-agent: *", "Allow: /", ...ROBOTS_DISALLOWED_PATHS.map((path) => `Disallow: ${path}`)]
    : ["# Non-production environment: nothing here should be indexed.", "User-agent: *", "Disallow: /"];
  return [
    ...lines,
    "",
    `Sitemap: ${canonicalUrl(input.siteUrl, "/sitemap.xml")}`,
    "",
    "# Machine-readable guides for AI agents:",
    `# ${canonicalUrl(input.siteUrl, "/llms.txt")}`,
    `# ${canonicalUrl(input.siteUrl, "/openapi.json")}`,
    "",
  ].join("\n");
}
