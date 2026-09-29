import { sql } from "drizzle-orm";

import type { MarketplaceDeps } from "../deps";

export interface HealthReport {
  status: "ok" | "degraded";
  checkedAt: string;
  checks: { database: "ok" | "error" };
}

/** Liveness plus a real round-trip to D1, so "healthy" means the Worker can actually serve data. */
export async function checkHealth(deps: MarketplaceDeps): Promise<HealthReport> {
  let database: "ok" | "error" = "ok";
  try {
    await deps.db.run(sql`select 1`);
  } catch (error) {
    console.error("health: database check failed", error);
    database = "error";
  }
  return {
    status: database === "ok" ? "ok" : "degraded",
    checkedAt: deps.now().toISOString(),
    checks: { database },
  };
}
