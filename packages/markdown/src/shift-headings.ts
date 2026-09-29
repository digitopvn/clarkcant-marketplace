/**
 * Post-sanitize pass that nests rendered Markdown under a host page's own outline. It works on the HTML tree, never on
 * serialized HTML, so text inside attribute values (a link `title`, an image `alt`) can never be mistaken for markup.
 * It only renames heading elements, adds one numeric data attribute and may remove a leading heading element.
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
  value?: string;
  children?: HastNode[];
}
type HastNode = HastElement | HastText | HastOther;
interface HastParent {
  children: HastNode[];
}

export interface ShiftHeadingsOptions {
  /** Levels to add to every heading, clamped at h6. 0 leaves headings unchanged. */
  offset: number;
  /** When set, a leading `<h1>` whose text equals this (case and whitespace insensitive) is removed. */
  omitLeadingTitle?: string;
}

const HEADING = /^h([1-6])$/;

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function headingLevel(node: HastNode): number | null {
  if (!isElement(node)) return null;
  const match = HEADING.exec(node.tagName);
  return match ? Number(match[1]) : null;
}

function textContent(node: HastNode): string {
  if (node.type === "text") return (node as HastText).value;
  if ("children" in node && Array.isArray(node.children)) return node.children.map(textContent).join("");
  return "";
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function isBlankText(node: HastNode): boolean {
  return node.type === "text" && (node as HastText).value.trim() === "";
}

function dropLeadingTitle(root: HastParent, title: string): void {
  const index = root.children.findIndex((child) => !isBlankText(child));
  if (index === -1) return;
  const first = root.children[index];
  if (!first || headingLevel(first) !== 1) return;
  if (normalize(textContent(first)) !== normalize(title)) return;
  // Remove the heading and the blank text that follows it so the output does not open with a stray newline.
  let end = index + 1;
  while (end < root.children.length && isBlankText(root.children[end] as HastNode)) end += 1;
  root.children.splice(0, end);
}

function shift(parent: HastParent, offset: number): void {
  for (const child of parent.children) {
    const level = headingLevel(child);
    if (level !== null && isElement(child)) {
      child.tagName = `h${Math.min(6, level + offset)}`;
      // Original level, so the host can keep the visual hierarchy of the source document.
      child.properties.dataHeadingLevel = String(level);
    }
    if ("children" in child && Array.isArray(child.children)) shift(child as HastParent, offset);
  }
}

/** Validates the offset at the boundary: an integer from 0 to 5 (h1 + 5 = h6). */
export function assertHeadingOffset(offset: number): void {
  if (!Number.isInteger(offset) || offset < 0 || offset > 5) {
    throw new TypeError(`headingOffset must be an integer from 0 to 5, got ${String(offset)}`);
  }
}

/** unified plugin (rehype stage). Must run after sanitization. */
export function rehypeShiftHeadings(options: ShiftHeadingsOptions) {
  return (tree: { type: string }) => {
    const root = tree as unknown as HastParent;
    if (options.omitLeadingTitle !== undefined && normalize(options.omitLeadingTitle) !== "") {
      dropLeadingTitle(root, options.omitLeadingTitle);
    }
    if (options.offset > 0) shift(root, options.offset);
  };
}
