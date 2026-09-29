/**
 * WebMCP: tools a page exposes to an in-browser agent through `document.modelContext.registerTool(tool, { signal })`
 * (older builds expose `navigator.modelContext`). Registration is feature-detected, so browsers without WebMCP
 * simply get no tools, and every tool is withdrawn when the caller's `AbortSignal` fires (page navigation, island
 * unmount). Tools run with the visitor's own browser session against the public API; they add no privilege.
 */

/** JSON Schema describing a tool's input (WebMCP takes plain JSON Schema, not a validator). */
export interface JsonSchema {
  type: "object";
  properties: Record<string, Record<string, unknown>>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** A tool as handed to `registerTool`. */
export interface WebMcpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: JsonSchema;
  annotations?: { readOnlyHint?: boolean };
  execute(input: Record<string, unknown>): Promise<ToolResult>;
}

/** The part of the WebMCP `ModelContext` interface this package uses. */
export interface ModelContextLike {
  registerTool(tool: WebMcpTool, options?: { signal?: AbortSignal }): unknown;
}

interface GlobalWithModelContext {
  document?: { modelContext?: unknown };
  navigator?: { modelContext?: unknown };
}

function isModelContext(value: unknown): value is ModelContextLike {
  return typeof value === "object" && value !== null && typeof (value as { registerTool?: unknown }).registerTool === "function";
}

/** The page's model context, or `null` when the browser has no WebMCP. */
export function detectModelContext(scope: unknown = globalThis): ModelContextLike | null {
  const candidate = scope as GlobalWithModelContext;
  const fromDocument = candidate.document?.modelContext;
  if (isModelContext(fromDocument)) return fromDocument;
  const fromNavigator = candidate.navigator?.modelContext;
  return isModelContext(fromNavigator) ? fromNavigator : null;
}

export interface RegisterOptions {
  signal: AbortSignal;
  /** Defaults to the detected page context; tests pass a fake. */
  modelContext?: ModelContextLike | null;
}

/**
 * Registers `tools` until `signal` aborts. Returns the number registered (0 without WebMCP or when already aborted).
 * Implementations that ignore the `signal` option but return a registration with `unregister()` are cleaned up too.
 */
export function registerWebMcpTools(tools: readonly WebMcpTool[], options: RegisterOptions): number {
  const context = options.modelContext === undefined ? detectModelContext() : options.modelContext;
  if (!context || options.signal.aborted) return 0;
  let registered = 0;
  for (const tool of tools) {
    try {
      const registration = context.registerTool(tool, { signal: options.signal });
      const unregister = (registration as { unregister?: unknown } | null | undefined)?.unregister;
      if (typeof unregister === "function") {
        options.signal.addEventListener("abort", () => void unregister.call(registration), { once: true });
      }
      registered += 1;
    } catch (error) {
      // One rejected tool (e.g. a duplicate name from another script) must not block the others.
      console.warn(`WebMCP: could not register ${tool.name}`, error);
    }
  }
  return registered;
}

export function textResult(value: unknown): ToolResult {
  const structured =
    value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : { value };
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: structured };
}

export function errorResult(code: string, message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: `${code}: ${message}` }], structuredContent: { error: { code, message } } };
}
