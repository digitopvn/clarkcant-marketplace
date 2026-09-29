import { parseRuntimeVars } from "@marketplace/contracts";
import { createMarketplaceDeps } from "@marketplace/marketplace";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";

import { createApi } from "../src";

/*
 * The OpenAPI document is the contract the SDK, CLI and third-party agents are generated from, so every operation
 * must be fully described: identity, grouping, auth, request and response shapes, and the shared error body.
 */

interface Parameter {
  name: string;
  in: string;
}
interface MediaType {
  schema?: unknown;
}
interface Operation {
  operationId?: string;
  tags?: string[];
  summary?: string;
  security?: Record<string, string[]>[];
  parameters?: Parameter[];
  requestBody?: { content?: Record<string, MediaType> };
  responses?: Record<string, { content?: Record<string, MediaType> }>;
}
interface OpenApiDocument {
  security?: Record<string, string[]>[];
  tags?: { name: string; description?: string }[];
  components?: { securitySchemes?: Record<string, unknown> };
  paths: Record<string, Record<string, Operation>>;
}

const vars = parseRuntimeVars({ PUBLIC_SITE_URL: "http://localhost:4325", ENVIRONMENT: "development", ADMIN_EMAILS: "" });
const api = createApi({ resolveContext: () => ({ deps: createMarketplaceDeps({ d1: env.DB }), vars }) });

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

/** Operations whose handlers honour `Idempotency-Key`. */
const IDEMPOTENT = [
  "submitPackage",
  "setCurationStatus",
  "featurePackage",
  "manageCollection",
  "createPage",
  "createPageDraft",
  "patchPage",
  "addBlock",
  "updateBlock",
  "removeBlock",
  "moveBlock",
  "setPageSeo",
  "publishPage",
  "rollbackPage",
];
/** Operations that take the base revision as `If-Match`. */
const CONDITIONAL = ["createPageDraft", "patchPage", "addBlock", "updateBlock", "removeBlock", "moveBlock", "setPageSeo", "publishPage", "rollbackPage"];

let document: OpenApiDocument;
const operations: [string, string, Operation][] = [];

beforeAll(async () => {
  const response = await api.request("http://localhost:4325/openapi.json");
  expect(response.status).toBe(200);
  document = (await response.json()) as OpenApiDocument;
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const operation = item[method];
      if (operation) operations.push([method, path, operation]);
    }
  }
});

function headerNames(operation: Operation): string[] {
  return (operation.parameters ?? []).filter((parameter) => parameter.in === "header").map((parameter) => parameter.name.toLowerCase());
}

describe("OpenAPI completeness", () => {
  it("declares bearer and cookie security schemes and applies them to every operation", () => {
    expect(Object.keys(document.components?.securitySchemes ?? {})).toEqual(expect.arrayContaining(["bearerAuth", "sessionCookie"]));
    for (const [method, path, operation] of operations) {
      const security = operation.security ?? document.security;
      const names = (security ?? []).flatMap((entry) => Object.keys(entry));
      expect(names, `${method} ${path}`).toEqual(expect.arrayContaining(["bearerAuth", "sessionCookie"]));
    }
  });

  it("gives every operation a unique operationId, a described tag and a summary", () => {
    const described = new Set((document.tags ?? []).filter((tag) => tag.description).map((tag) => tag.name));
    const ids = new Set<string>();
    const unsummarised: string[] = [];
    for (const [method, path, operation] of operations) {
      const label = `${method} ${path}`;
      expect(operation.operationId, label).toMatch(/^[a-z][A-Za-z0-9]+$/);
      expect(ids.has(operation.operationId ?? ""), `${label} duplicates ${operation.operationId}`).toBe(false);
      ids.add(operation.operationId ?? "");
      expect(operation.tags?.length, label).toBeGreaterThan(0);
      for (const tag of operation.tags ?? []) expect(described.has(tag), `${label}: tag "${tag}" has no description`).toBe(true);
      if (!operation.summary) unsummarised.push(label);
    }
    expect(unsummarised).toEqual([]);
  });

  it("documents a success schema and the shared error body on every operation", () => {
    for (const [method, path, operation] of operations) {
      const label = `${method} ${path}`;
      const responses = Object.entries(operation.responses ?? {});
      const success = responses.filter(([status]) => status.startsWith("2"));
      expect(success.length, label).toBeGreaterThan(0);
      for (const [status, response] of success) {
        if (status === "204") continue;
        expect(response.content, `${label} ${status}`).toBeDefined();
      }
      const failures = responses.filter(([status]) => /^[45]/.test(status));
      expect(failures.length, label).toBeGreaterThan(0);
      for (const [status, response] of failures) {
        // Health reports its own body with 503 so monitors can read which dependency failed.
        if (operation.operationId === "getHealth" && status === "503") continue;
        expect(JSON.stringify(response.content?.["application/json"]?.schema ?? null), `${label} ${status}`).toContain("error");
      }
      if (method !== "get" && method !== "delete" && operation.requestBody) {
        expect(operation.requestBody.content?.["application/json"]?.schema, label).toBeDefined();
      }
    }
  });

  it("documents Idempotency-Key and If-Match where the handler honours them", () => {
    const byId = new Map(operations.map(([, , operation]) => [operation.operationId, operation]));
    for (const id of IDEMPOTENT) expect(headerNames(byId.get(id) ?? {}), id).toContain("idempotency-key");
    for (const id of CONDITIONAL) expect(headerNames(byId.get(id) ?? {}), id).toContain("if-match");
  });
});
