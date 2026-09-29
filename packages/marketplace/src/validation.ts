import { MarketplaceError } from "@marketplace/contracts";
import type { z } from "zod";

/**
 * Validates input at the service boundary. Every service parses its own input, so a caller that skipped the HTTP
 * layer's validation (MCP, CLI, jobs) still cannot pass malformed data into a query.
 */
export function parseInput<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new MarketplaceError("validation_failed", "input failed validation", {
    details: result.error.issues.map((issue) => ({ path: issue.path.map(String), message: issue.message })),
  });
}
