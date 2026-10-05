import { isMarketplaceApiError, type MarketplaceClient } from "@marketplace/sdk";

import { errorResult, textResult, type JsonSchema, type ToolResult, type WebMcpTool } from "./model-context";

/** Runs a tool body, turning failures into tool error results (API codes are kept; nothing else leaks). */
function tool(
  definition: Omit<WebMcpTool, "execute">,
  run: (input: Record<string, unknown>) => Promise<unknown>,
): WebMcpTool {
  return {
    ...definition,
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      try {
        return textResult(await run(input ?? {}));
      } catch (error) {
        if (isMarketplaceApiError(error)) return errorResult(error.code, error.message);
        if (error instanceof ToolInputError) return errorResult("validation_failed", error.message);
        return errorResult("internal_error", "The tool failed unexpectedly");
      }
    },
  };
}

class ToolInputError extends Error {}

const NO_INPUT: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new ToolInputError(`${key} must be a string`);
  return value;
}

function optionalLimit(input: Record<string, unknown>, max: number): number | undefined {
  const value = input.limit;
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > max) {
    throw new ToolInputError(`limit must be an integer from 1 to ${max}`);
  }
  return value;
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = optionalString(input, key);
  if (!value) throw new ToolInputError(`${key} is required`);
  return value;
}

function objectInput(input: Record<string, unknown>, key: string, required: boolean): Record<string, unknown> | undefined {
  const value = input[key];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ToolInputError(`${key} must be an object`);
  return value as Record<string, unknown>;
}

// --- Package detail page ----------------------------------------------------------------------------------------

export interface PackagePageToolOptions {
  client: MarketplaceClient;
  /** The package this page shows. */
  packageName: string;
  /** Writes text to the clipboard; the browser may refuse without a user gesture. */
  writeClipboard?: (text: string) => Promise<void>;
}

export function packagePageTools(options: PackagePageToolOptions): WebMcpTool[] {
  const { client, packageName } = options;
  const install = (input: Record<string, unknown>) => client.getPackageInstall(packageName, optionalString(input, "version"));
  const versionInput: JsonSchema = {
    type: "object",
    properties: { version: { type: "string", description: "Exact version; the latest when omitted" } },
    additionalProperties: false,
  };

  return [
    tool(
      {
        name: "get_current_package",
        title: "Current package",
        description: "Details of the package this page shows: description, latest version, facets, permissions and security checks.",
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
      },
      () => client.getPackage(packageName),
    ),
    tool(
      {
        name: "get_versions",
        title: "Package versions",
        description: "Indexed versions of the package this page shows, newest first.",
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
      },
      async () => ({ package: packageName, items: await client.listPackageVersions(packageName) }),
    ),
    tool(
      {
        name: "inspect_permissions",
        title: "Inspect permissions",
        description:
          "Permissions the latest version declares, its facets, and what each service provides and reaches. " +
          "ClarkCant asks the user to grant them at install " +
          "time; nothing here grants anything.",
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const detail = await client.getPackage(packageName);
        return {
          package: detail.name,
          version: detail.latest?.version ?? null,
          permissions: detail.latest?.permissions ?? [],
          facets: detail.latest?.facets ?? [],
          services: detail.latest?.services ?? [],
          browserTokens: detail.latest?.browserTokens ?? [],
          resources: detail.latest?.resources ?? null,
        };
      },
    ),
    tool(
      {
        name: "find_similar_widgets",
        title: "Similar widgets",
        description: "Packages sharing keywords, category or facet kind with this one, best match first, with the reasons.",
        inputSchema: {
          type: "object",
          properties: { limit: { type: "integer", minimum: 1, maximum: 20 } },
          additionalProperties: false,
        },
        annotations: { readOnlyHint: true },
      },
      async (input) => ({ items: await client.findSimilarPackages(packageName, optionalLimit(input, 20) ?? 5) }),
    ),
    tool(
      {
        name: "open_in_clarkcant",
        title: "Open in ClarkCant",
        description:
          "The ClarkCant deep link and exact install coordinate (name, version, npm integrity) for the user to open. " +
          "It never installs: ClarkCant shows the permissions and asks the user before installing anything.",
        inputSchema: versionInput,
        annotations: { readOnlyHint: true },
      },
      async (input) => {
        const coordinate = await install(input);
        return {
          deepLink: coordinate.openInClarkCant,
          coordinate: { package: coordinate.package, version: coordinate.version, source: coordinate.source, integrity: coordinate.integrity },
          note: "Ask the user to open the link; ClarkCant verifies the integrity and reviews permissions before installing.",
        };
      },
    ),
    tool(
      {
        name: "copy_package_reference",
        title: "Copy package reference",
        description: "Copies `name@version` (or the deep link) to the clipboard and returns it.",
        inputSchema: {
          type: "object",
          properties: {
            version: { type: "string", description: "Exact version; the latest when omitted" },
            format: { type: "string", enum: ["reference", "deep-link"], description: "Default `reference` (name@version)" },
          },
          additionalProperties: false,
        },
      },
      async (input) => {
        const format = optionalString(input, "format") ?? "reference";
        if (format !== "reference" && format !== "deep-link") throw new ToolInputError("format must be reference or deep-link");
        const coordinate = await install(input);
        const text = format === "deep-link" ? coordinate.openInClarkCant : `${coordinate.package}@${coordinate.version}`;
        let copied = false;
        if (options.writeClipboard) {
          try {
            await options.writeClipboard(text);
            copied = true;
          } catch {
            // Clipboard access needs focus or a user gesture; the text is still returned for the agent to show.
          }
        }
        return { text, copied };
      },
    ),
  ];
}

// --- Admin page builder -----------------------------------------------------------------------------------------

/** What the builder currently shows. The draft revision is re-read from the API, so it is never stale. */
export interface BuilderSnapshot {
  pageId: string;
  selectedBlockId: string | null;
  /** True while the builder holds unsaved edits; tools refuse to write then, so nothing is overwritten. */
  dirty: boolean;
}

export interface PageBuilderToolOptions {
  client: MarketplaceClient;
  snapshot: () => BuilderSnapshot;
  /** Called after a tool saved a new draft revision, so the builder can load it. */
  onDraftChanged?: (revisionId: string) => void;
  /** Absolute preview URLs are built from this origin. */
  origin: string;
}

export function pageBuilderTools(options: PageBuilderToolOptions): WebMcpTool[] {
  const { client } = options;

  const writableSnapshot = () => {
    const snapshot = options.snapshot();
    if (snapshot.dirty) {
      throw new ToolInputError("the builder has unsaved changes; ask the user to save or discard them first");
    }
    return snapshot;
  };

  const applyOperations = async (pageId: string, operations: Record<string, unknown>[]) => {
    const state = await client.getPage(pageId);
    const result = await client.patchPage(pageId, state.draft.revision.id, operations as never);
    options.onDraftChanged?.(result.draft.revision.id);
    return { draftRevisionId: result.draft.revision.id, results: result.results };
  };

  return [
    tool(
      {
        name: "update_selected_block",
        title: "Update the selected block",
        description:
          "Merges props into the block selected in the builder and saves a new draft revision (never publishes). " +
          "Fails while the builder has unsaved changes or nothing is selected.",
        inputSchema: {
          type: "object",
          properties: { props: { type: "object", description: "Props to set on the selected block" } },
          required: ["props"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const snapshot = writableSnapshot();
        if (!snapshot.selectedBlockId) throw new ToolInputError("no block is selected in the builder");
        const props = objectInput(input, "props", true);
        return applyOperations(snapshot.pageId, [{ op: "update_block", blockId: snapshot.selectedBlockId, props, mode: "merge" }]);
      },
    ),
    tool(
      {
        name: "add_block",
        title: "Add a block",
        description:
          "Adds a block (e.g. `hero`, `markdown`) to the draft and saves a new draft revision (never publishes). By " +
          "default it goes after the selected block, or at the end of the page.",
        inputSchema: {
          type: "object",
          properties: {
            type: { type: "string", description: "Registered block type" },
            props: { type: "object", description: "Props merged over the block's defaults" },
            parentId: { type: ["string", "null"], description: "Container block id; null for the page root" },
            beforeId: { type: "string" },
            afterId: { type: "string" },
          },
          required: ["type"],
          additionalProperties: false,
        },
      },
      async (input) => {
        const snapshot = writableSnapshot();
        const type = requiredString(input, "type");
        const props = objectInput(input, "props", false);
        const beforeId = optionalString(input, "beforeId");
        const explicitAfter = optionalString(input, "afterId");
        const parentId = input.parentId === null ? null : optionalString(input, "parentId");
        const afterId = explicitAfter ?? (beforeId || parentId !== undefined ? undefined : (snapshot.selectedBlockId ?? undefined));
        const operation: Record<string, unknown> = { op: "add_block", block: { type, ...(props ? { props } : {}) } };
        if (parentId !== undefined) operation.parentId = parentId;
        if (beforeId) operation.beforeId = beforeId;
        if (afterId) operation.afterId = afterId;
        return applyOperations(snapshot.pageId, [operation]);
      },
    ),
    tool(
      {
        name: "preview_page",
        title: "Preview the draft",
        description: "A signed, expiring preview URL for the saved draft. Unsaved builder edits are not included.",
        inputSchema: NO_INPUT,
        annotations: { readOnlyHint: true },
      },
      async () => {
        const snapshot = options.snapshot();
        const link = await client.previewPage(snapshot.pageId);
        return { url: new URL(link.path, options.origin).href, expiresAt: link.expiresAt, revisionId: link.revisionId, unsavedChanges: snapshot.dirty };
      },
    ),
  ];
}
