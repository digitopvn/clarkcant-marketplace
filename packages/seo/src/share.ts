/**
 * "Send to AI" share targets. Provider URL formats live only here, so a provider changing its URL (or dropping
 * prefill support) is a one-line change instead of a hunt through the UI. Client-safe: no imports.
 *
 * Every target receives the same prompt, which names the canonical URL and the Markdown URL; the Markdown twin is
 * what an assistant should read. Providers that cannot take a prefilled prompt open their start page and the UI
 * copies the prompt to the clipboard first (`prefill: false`).
 */
export interface SharePayload {
  title: string;
  canonicalUrl: string;
  /** Null when the page has no Markdown twin. */
  markdownUrl: string | null;
}

export interface ShareTarget {
  id: "chatgpt" | "claude" | "perplexity" | "gemini";
  label: string;
  /** True when the provider reads the prompt from the URL; false when the user pastes a copied prompt. */
  prefill: boolean;
  url(payload: SharePayload): string;
}

/** Keeps generated URLs well below common URL length limits (browsers, proxies, provider front-ends). */
export const MAX_PROMPT_LENGTH = 1_500;

export function sharePrompt(payload: SharePayload): string {
  const title = payload.title.replace(/\s+/g, " ").trim().slice(0, 200);
  const source = payload.markdownUrl
    ? `Read the Markdown version at ${payload.markdownUrl} (web page: ${payload.canonicalUrl})`
    : `Read ${payload.canonicalUrl}`;
  const prompt = `${source} and help me with "${title}" from the ClarkCant Marketplace.`;
  return prompt.length <= MAX_PROMPT_LENGTH ? prompt : `${prompt.slice(0, MAX_PROMPT_LENGTH - 1)}…`;
}

export const SHARE_TARGETS: readonly ShareTarget[] = [
  {
    id: "chatgpt",
    label: "ChatGPT",
    prefill: true,
    url: (payload) => `https://chatgpt.com/?q=${encodeURIComponent(sharePrompt(payload))}`,
  },
  {
    id: "claude",
    label: "Claude",
    prefill: true,
    url: (payload) => `https://claude.ai/new?q=${encodeURIComponent(sharePrompt(payload))}`,
  },
  {
    id: "perplexity",
    label: "Perplexity",
    prefill: true,
    url: (payload) => `https://www.perplexity.ai/search?q=${encodeURIComponent(sharePrompt(payload))}`,
  },
  {
    // Gemini has no documented prompt parameter: open it and let the user paste the copied prompt.
    id: "gemini",
    label: "Gemini",
    prefill: false,
    url: () => "https://gemini.google.com/app",
  },
];

export function getShareTarget(id: string): ShareTarget | undefined {
  return SHARE_TARGETS.find((target) => target.id === id);
}

/** The plain-text fallback every share path can fall back to: canonical URL plus Markdown URL. */
export function shareFallbackText(payload: SharePayload): string {
  return payload.markdownUrl ? `${payload.canonicalUrl}\nMarkdown: ${payload.markdownUrl}` : payload.canonicalUrl;
}
