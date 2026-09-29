/**
 * Post-sanitize pass over the HTML tree. The sanitizer has already removed disallowed protocols; this pass decides what
 * happens to relative URLs and marks outbound links. It only ever removes or narrows attributes, never widens them.
 */

interface HastText {
  type: "text";
  value: string;
}
interface HastElement {
  type: "element";
  tagName: string;
  properties: Record<string, unknown>;
  children: HastNode[];
}
interface HastOther {
  type: string;
  children?: HastNode[];
}
type HastNode = HastElement | HastText | HastOther;
interface HastParent {
  children: HastNode[];
}

export interface RewriteUrlOptions {
  /** Absolute http(s) base used to resolve relative link and image URLs. Relative images are dropped without it. */
  baseUrl?: URL;
  /** `rel` tokens for links that leave the site. */
  linkRel: string[];
}

type Classified = { kind: "fragment" } | { kind: "absolute"; url: URL } | { kind: "relative"; raw: string };

function classify(raw: string): Classified {
  if (raw.startsWith("#")) return { kind: "fragment" };
  if (raw.startsWith("//")) {
    try {
      return { kind: "absolute", url: new URL(`https:${raw}`) };
    } catch {
      return { kind: "relative", raw };
    }
  }
  try {
    return { kind: "absolute", url: new URL(raw) };
  } catch {
    return { kind: "relative", raw };
  }
}

function resolve(raw: string, baseUrl: URL | undefined): Classified {
  const classified = classify(raw);
  if (classified.kind !== "relative" || !baseUrl) return classified;
  try {
    return { kind: "absolute", url: new URL(raw, baseUrl) };
  } catch {
    return classified;
  }
}

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function rewriteLink(node: HastElement, options: RewriteUrlOptions): void {
  const href = node.properties.href;
  if (typeof href !== "string") return;
  const target = resolve(href, options.baseUrl);
  if (target.kind === "absolute") {
    node.properties.href = target.url.href;
    if (target.url.protocol === "http:" || target.url.protocol === "https:") node.properties.rel = [...options.linkRel];
  }
}

/** Returns false when the image must be removed (no safe, absolute https source can be derived). */
function rewriteImage(node: HastElement, options: RewriteUrlOptions): boolean {
  const src = node.properties.src;
  if (typeof src !== "string" || src.length === 0) return false;
  const target = resolve(src, options.baseUrl);
  if (target.kind !== "absolute" || target.url.protocol !== "https:") return false;
  node.properties.src = target.url.href;
  node.properties.loading = "lazy";
  node.properties.decoding = "async";
  node.properties.referrerPolicy = "no-referrer";
  return true;
}

function walk(parent: HastParent, options: RewriteUrlOptions): void {
  const kept: HastNode[] = [];
  for (const child of parent.children) {
    if (isElement(child)) {
      if (child.tagName === "img") {
        if (!rewriteImage(child, options)) {
          const alt = child.properties.alt;
          if (typeof alt === "string" && alt.length > 0) kept.push({ type: "text", value: alt });
          continue;
        }
      } else if (child.tagName === "a") {
        rewriteLink(child, options);
      }
    }
    if ("children" in child && Array.isArray(child.children)) walk(child as HastParent, options);
    kept.push(child);
  }
  parent.children = kept;
}

/** unified plugin (rehype stage). */
export function rehypeRewriteUrls(options: RewriteUrlOptions) {
  return (tree: { type: string }) => {
    walk(tree as unknown as HastParent, options);
  };
}
