import { MarketplaceError } from "@marketplace/contracts";
import { describe, expect, it } from "vitest";

import { MAX_DOCUMENT_BYTES, PageOperationError, applyPageOperations, parsePageDocument, registryBlockDefaults, validatePageDocument } from "../src";
import { escapeMarkdown, mdInlineCode } from "../src/markdown-text";
import { documentWith } from "./support";

const hero = { id: "hero", type: "hero", version: 1, props: { title: "Hello" } };
const text = (id: string) => ({ id, type: "rich-text", version: 1, props: { markdown: `Text ${id}` } });

function issuesOf(input: unknown): string[] {
  const result = validatePageDocument(input);
  return result.ok ? [] : result.issues.map((issue) => issue.message);
}

describe("validatePageDocument", () => {
  it("accepts a valid document and fills block defaults", () => {
    const result = validatePageDocument(documentWith([hero, text("a")]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.document.blocks[0]?.props).toMatchObject({ title: "Hello", align: "start", tone: "plain" });
  });

  it("rejects envelope, layout, block, child and region errors", () => {
    expect(issuesOf({ schemaVersion: 2 })).not.toEqual([]);
    expect(issuesOf({ ...documentWith([]), layout: { id: "nope", version: 1 } })).toEqual(["unknown layout nope@1"]);
    expect(issuesOf(documentWith([{ id: "x", type: "carousel", version: 1, props: {} }]))).toEqual(["unknown block carousel@1"]);
    expect(issuesOf(documentWith([{ id: "x", type: "hero", version: 9, props: {} }]))).toEqual(["unknown block hero@9"]);
    expect(issuesOf(documentWith([{ ...hero, props: { title: "" } }]))[0]).toMatch(/required|at least/i);
    expect(issuesOf(documentWith([{ ...text("t"), children: [text("c")] }]))).toEqual(["rich-text blocks cannot contain other blocks"]);
    expect(issuesOf(documentWith([{ ...hero, children: [text("c")] }]))[0]).toMatch(/not allowed inside hero/);
    expect(issuesOf(documentWith([text("a"), hero]))[0]).toMatch(/hero cannot appear here/);
    expect(issuesOf(documentWith([hero, { ...hero, id: "hero2" }]))[0]).toMatch(/hero cannot appear here/);
    expect(issuesOf(documentWith([hero, { ...hero, id: "hero" }]))).toContain('duplicate block id "hero"');
    // Package showcases are not allowed on policy pages.
    expect(issuesOf(documentWith([{ id: "g", type: "package-grid", version: 1, props: {} }], "docs-legal"))[0]).toMatch(/cannot appear here/);
  });

  it("rejects oversized documents", () => {
    const blocks = Array.from({ length: 20 }, (_, index) => ({
      id: `t${index}`,
      type: "rich-text",
      version: 1,
      props: { markdown: "x".repeat(19_000) },
    }));
    expect(issuesOf(documentWith(blocks)).join(" ")).toContain(`limit is ${MAX_DOCUMENT_BYTES}`);
  });

  it("throws validation_failed with field paths from parsePageDocument", () => {
    try {
      parsePageDocument(documentWith([{ ...hero, props: { title: "" } }]));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(MarketplaceError);
      expect((error as MarketplaceError).code).toBe("validation_failed");
      expect((error as MarketplaceError).details).toEqual([expect.objectContaining({ path: ["blocks", "0", "props", "title"], blockId: "hero" })]);
    }
  });
});

describe("applyPageOperations", () => {
  let counter = 0;
  const context = { newId: () => `gen${(counter += 1)}`, blockDefaults: registryBlockDefaults };

  it("adds, updates, moves and removes blocks by stable id", () => {
    const start = documentWith([hero, text("a"), text("b")]);
    const { document, results } = applyPageOperations(
      start,
      [
        { op: "add_block", block: { type: "faq" }, afterId: "a" },
        { op: "update_block", blockId: "a", props: { markdown: "Changed" } },
        { op: "move_block", blockId: "b", beforeId: "a" },
        { op: "add_block", block: { type: "cta", props: { primary: { label: "Go", href: "/x" } } }, parentId: "hero" },
        { op: "remove_block", blockId: "a" },
        { op: "set_page_seo", seo: { title: "New title", noindex: true } },
      ],
      context,
    );
    expect(results[0]).toEqual({ op: "add_block", blockId: "gen1" });
    expect(document.blocks.map((block) => block.id)).toEqual(["hero", "b", "gen1"]);
    expect(document.blocks[0]?.children?.map((block) => block.type)).toEqual(["cta"]);
    expect(document.meta).toMatchObject({ title: "New title", noindex: true, description: "About the marketplace" });
    expect(validatePageDocument(document).ok).toBe(true);
    // The input document is never mutated.
    expect(start.blocks.map((block) => block.id)).toEqual(["hero", "a", "b"]);
  });

  it("moves a nested block back to the root and drops empty child lists", () => {
    const start = documentWith([{ ...hero, children: [{ id: "c", type: "cta", version: 1, props: { primary: { label: "Go", href: "/x" } } }] }]);
    const { document } = applyPageOperations(start, [{ op: "move_block", blockId: "c", parentId: null }], context);
    expect(document.blocks.map((block) => block.id)).toEqual(["hero", "c"]);
    expect(document.blocks[0]?.children).toBeUndefined();
  });

  it("names the failing operation", () => {
    const start = documentWith([hero, text("a")]);
    const attempts: [unknown[], RegExp][] = [
      [[{ op: "remove_block", blockId: "missing" }], /operation 0 \(remove_block\): block "missing" does not exist/],
      [[{ op: "add_block", block: { type: "nope" } }], /unknown block type/],
      [[{ op: "move_block", blockId: "hero", parentId: "hero" }], /inside itself/],
      [[{ op: "add_block", block: { id: "a", type: "faq" } }], /already exists/],
      [[{ op: "update_block", blockId: "a" }], /operation 0/],
    ];
    for (const [operations, message] of attempts) {
      expect(() => applyPageOperations(start, operations as never, context)).toThrow(PageOperationError);
      expect(() => applyPageOperations(start, operations as never, context)).toThrow(message);
    }
  });
});

describe("markdown escaping", () => {
  it("keeps punctuation readable but neutralises inline and line-start syntax", () => {
    expect(escapeMarkdown("Version 1.2 (beta) is here.")).toBe("Version 1.2 (beta) is here.");
    expect(escapeMarkdown("*bold* [link](x) <b> a|b")).toBe("\\*bold\\* \\[link\\](x) \\<b\\> a\\|b");
    expect(escapeMarkdown("1. first")).toBe("1\\. first");
    expect(escapeMarkdown("# not a heading")).toBe("\\# not a heading");
    expect(escapeMarkdown("- not a list")).toBe("\\- not a list");
    expect(escapeMarkdown(["two", "lines"].join(String.fromCharCode(10)))).toBe("two lines");
  });

  it("fences inline code so the value cannot close the span", () => {
    expect(mdInlineCode("tasks.write")).toBe("`tasks.write`");
    expect(mdInlineCode("a`b")).toBe("``a`b``");
    expect(mdInlineCode("x``[l](u)`")).toBe("``` x``[l](u)` ```");
    expect(mdInlineCode(" padded")).toBe("`  padded `");
    expect(mdInlineCode(["two", "lines"].join(String.fromCharCode(10)))).toBe("`two lines`");
  });

  it("rejects block props that are not in the block's schema", () => {
    expect(issuesOf(documentWith([{ ...hero, props: { title: "Hi", heading: "typo" } }]))).toContain('unknown property "heading"');
  });
});
