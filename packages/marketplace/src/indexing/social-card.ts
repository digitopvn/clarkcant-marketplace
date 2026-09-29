/**
 * Social card (Open Graph image) for a package version, generated as SVG from listing text.
 *
 * All text is XML-escaped and the SVG contains no script, links, external references or foreign objects; it is
 * additionally served under a sandboxing CSP by the media route. PNG rasterisation (resvg-wasm) is not bundled:
 * the jobs Worker stays small and SVG covers the site's own use; see the indexing docs for the trade-off.
 */

export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

export interface SocialCardInput {
  name: string;
  displayName: string;
  description: string;
  version: string;
  /** Isolation lanes of the version's facets, shown so the card never hides how a package runs. */
  isolation: string[];
}

/** XML 1.0 forbids most C0 control characters even when escaped; drop them (keeping tab, LF and CR). */
function stripControlCharacters(value: string): string {
  return Array.from(value)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f);
    })
    .join("");
}

function escapeXml(value: string): string {
  return stripControlCharacters(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function truncate(value: string, max: number): string {
  const chars = [...value.trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

/** Greedy word wrap by character count; good enough for a fixed-width card layout. */
function wrap(value: string, width: number, maxLines: number): string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if ([...candidate].length <= width) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = truncate(word, width);
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines && words.join(" ").length > lines.join(" ").length) {
    lines[maxLines - 1] = truncate(`${lines[maxLines - 1] ?? ""}…`, width);
  }
  return lines;
}

export function renderSocialCardSvg(input: SocialCardInput): string {
  const title = escapeXml(truncate(input.displayName, 40));
  const coordinate = escapeXml(truncate(`${input.name}@${input.version}`, 64));
  const description = wrap(input.description || "A ClarkCant package.", 52, 3).map(escapeXml);
  const lanes = escapeXml(truncate(input.isolation.length > 0 ? `Runs as: ${[...new Set(input.isolation)].join(", ")}` : "", 70));

  const descriptionLines = description
    .map((line, index) => `<tspan x="80" dy="${index === 0 ? 0 : 46}">${line}</tspan>`)
    .join("");

  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" viewBox="0 0 ${SOCIAL_CARD_WIDTH} ${SOCIAL_CARD_HEIGHT}" role="img" aria-label="${title}">`,
    `<defs><linearGradient id="spectrum" x1="0" x2="1" y1="0" y2="0">`,
    `<stop offset="0" stop-color="#82f4ff"/><stop offset="0.22" stop-color="#ffffff"/><stop offset="0.45" stop-color="#ffd86b"/>`,
    `<stop offset="0.72" stop-color="#ff7bff"/><stop offset="1" stop-color="#8e6cff"/></linearGradient></defs>`,
    `<rect width="100%" height="100%" fill="#0c0d11"/>`,
    `<rect x="0" y="0" width="100%" height="10" fill="url(#spectrum)"/>`,
    `<text x="80" y="120" fill="#8e6cff" font-family="Geist, 'Segoe UI', Arial, sans-serif" font-size="30" letter-spacing="2">CLARKCANT MARKETPLACE</text>`,
    `<text x="80" y="230" fill="#eff1f5" font-family="'Instrument Serif', Georgia, serif" font-size="84">${title}</text>`,
    `<text x="80" y="300" fill="#eff1f5" font-family="Geist, 'Segoe UI', Arial, sans-serif" font-size="34" opacity="0.8">${descriptionLines}</text>`,
    `<text x="80" y="520" fill="#eff1f5" font-family="'Geist Mono', Consolas, monospace" font-size="30">${coordinate}</text>`,
    `<text x="80" y="570" fill="#eff1f5" font-family="Geist, 'Segoe UI', Arial, sans-serif" font-size="26" opacity="0.7">${lanes}</text>`,
    `</svg>`,
  ].join("");
}
