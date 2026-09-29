import { describe, expect, it } from "vitest";

import {
  MarketplaceError,
  NotImplementedError,
  PUBLISHED_SCHEMA_NAMES,
  decodeOffsetCursor,
  encodeOffsetCursor,
  hasScope,
  pageDocumentSchema,
  parseRuntimeVars,
  searchQuerySchema,
  toJsonSchema,
} from "../src";

describe("runtime vars", () => {
  it("parses and normalizes valid configuration", () => {
    expect(
      parseRuntimeVars({
        PUBLIC_SITE_URL: "https://market.example.com/",
        ENVIRONMENT: "staging",
        ADMIN_EMAILS: " Admin@Example.com, ops@example.com ,",
      }),
    ).toEqual({
      PUBLIC_SITE_URL: "https://market.example.com",
      ENVIRONMENT: "staging",
      ADMIN_EMAILS: ["admin@example.com", "ops@example.com"],
    });
  });

  it("fails fast naming every bad variable without echoing values", () => {
    let caught: unknown;
    try {
      parseRuntimeVars({ PUBLIC_SITE_URL: "ftp://nope", ENVIRONMENT: "prod", ADMIN_EMAILS: "not-an-email" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MarketplaceError);
    const problem = caught as MarketplaceError;
    expect(problem.code).toBe("configuration_error");
    for (const name of ["PUBLIC_SITE_URL", "ENVIRONMENT", "ADMIN_EMAILS"]) expect(problem.message).toContain(name);
    expect(problem.message).not.toContain("not-an-email");
  });
});

describe("errors", () => {
  it("maps codes to HTTP statuses", () => {
    expect(new MarketplaceError("not_found", "x").status).toBe(404);
    const notImplemented = new NotImplementedError("indexPackage");
    expect(notImplemented.status).toBe(501);
    expect(notImplemented.details).toEqual({ feature: "indexPackage" });
  });
});

describe("pagination cursors", () => {
  it("round-trips offsets and rejects garbage", () => {
    expect(decodeOffsetCursor(encodeOffsetCursor(40))).toBe(40);
    expect(decodeOffsetCursor(undefined)).toBe(0);
    expect(decodeOffsetCursor("40")).toBeNull();
    expect(decodeOffsetCursor("o-1")).toBeNull();
  });
});

describe("scopes", () => {
  it("treats admin as a superset and otherwise requires the exact scope", () => {
    expect(hasScope(["admin"], "pages:publish")).toBe(true);
    expect(hasScope(["pages:write"], "pages:publish")).toBe(false);
  });
});

describe("search query", () => {
  it("applies defaults and bounds", () => {
    expect(searchQuerySchema.parse({})).toEqual({ q: "", limit: 20 });
    expect(searchQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(searchQuerySchema.parse({ q: "  chart ", limit: "5" })).toEqual({ q: "chart", limit: 5 });
  });
});

describe("page document", () => {
  const document = {
    schemaVersion: 1,
    layout: { id: "default", version: 1 },
    meta: { title: "About" },
    blocks: [
      { id: "hero", type: "hero", version: 1, props: {}, children: [{ id: "cta", type: "button", version: 1, props: {} }] },
    ],
  };

  it("accepts nested blocks and fills meta defaults", () => {
    const parsed = pageDocumentSchema.parse(document);
    expect(parsed.meta).toEqual({ title: "About", description: "", locale: "en", noindex: false });
  });

  it("rejects duplicate block ids and unknown schema versions", () => {
    const duplicate = { ...document, blocks: [...document.blocks, { id: "cta", type: "text", version: 1, props: {} }] };
    expect(pageDocumentSchema.safeParse(duplicate).success).toBe(false);
    expect(pageDocumentSchema.safeParse({ ...document, schemaVersion: 2 }).success).toBe(false);
  });
});

describe("JSON Schema export", () => {
  it("exports every published contract as JSON Schema 2020-12", () => {
    for (const name of PUBLISHED_SCHEMA_NAMES) {
      expect(toJsonSchema(name).$schema, name).toBe("https://json-schema.org/draft/2020-12/schema");
    }
    expect(toJsonSchema("clarkcant-manifest")).toHaveProperty("anyOf");
  });
});
