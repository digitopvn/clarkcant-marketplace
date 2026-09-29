import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";

import { rehypeRewriteUrls } from "./rewrite-urls.ts";
import { strictSanitizeSchema } from "./safe-html-schema.ts";

export { strictSanitizeSchema } from "./safe-html-schema.ts";

/** Default `rel` for links that leave the site: untrusted, user-generated content never passes ranking or opener. */
export const UGC_LINK_REL = ["nofollow", "ugc", "noopener", "noreferrer"] as const;

/** 1 MiB of Markdown source is far beyond any real README; larger input is rejected rather than parsed. */
export const DEFAULT_MAX_MARKDOWN_LENGTH = 1_048_576;

export interface RenderMarkdownOptions {
  /**
   * Absolute http(s) URL that relative link and image URLs resolve against, e.g. an npm CDN path for one package
   * version. Without it, relative images are dropped (their alt text is kept) and relative links stay relative.
   */
  baseUrl?: string;
  /** `rel` tokens for outbound http(s) links. Defaults to {@link UGC_LINK_REL}. */
  linkRel?: readonly string[];
  /** Maximum accepted source length in UTF-16 code units. Defaults to {@link DEFAULT_MAX_MARKDOWN_LENGTH}. */
  maxLength?: number;
}

export class MarkdownInputTooLargeError extends Error {
  readonly length: number;
  readonly maxLength: number;

  constructor(length: number, maxLength: number) {
    super(`Markdown input is ${length} characters; the limit is ${maxLength}`);
    this.name = "MarkdownInputTooLargeError";
    this.length = length;
    this.maxLength = maxLength;
  }
}

function parseBaseUrl(baseUrl: string | undefined): URL | undefined {
  if (baseUrl === undefined) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new TypeError(`baseUrl must be an absolute URL, got ${JSON.stringify(baseUrl)}`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError(`baseUrl must use http(s), got ${parsed.protocol}`);
  }
  return parsed;
}

/**
 * Markdown (CommonMark + GFM) to sanitized HTML. Raw HTML embedded in the Markdown is never passed through; the
 * generated tree is filtered by {@link strictSanitizeSchema}, then relative URLs are resolved or dropped and outbound
 * links get `rel="nofollow ugc noopener noreferrer"`. Synchronous and deterministic, safe to call per request.
 */
export function renderMarkdownToSafeHtml(md: string, opts: RenderMarkdownOptions = {}): string {
  const maxLength = opts.maxLength ?? DEFAULT_MAX_MARKDOWN_LENGTH;
  if (md.length > maxLength) throw new MarkdownInputTooLargeError(md.length, maxLength);

  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSanitize, strictSanitizeSchema)
    .use(rehypeRewriteUrls, { baseUrl: parseBaseUrl(opts.baseUrl), linkRel: [...(opts.linkRel ?? UGC_LINK_REL)] })
    .use(rehypeStringify);

  return String(processor.processSync(md));
}
