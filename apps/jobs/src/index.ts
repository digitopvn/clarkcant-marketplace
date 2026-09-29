import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ingestMessageSchema, parseRuntimeVars, packageNameSchema, type IngestMessage } from "@marketplace/contracts";
import {
  IndexingRejectedError,
  createMarketplaceDeps,
  discoverNpmPackages,
  ensureDefaultPagesAsSystem,
  handleIngestMessage,
  indexPackage,
  isIndexingRejection,
  type IndexPackageParams,
  type IndexPackageResult,
  type IndexingRejectionCode,
  type MarketplaceDeps,
  type StepRunner,
} from "@marketplace/marketplace";
import { z } from "zod";

/**
 * The jobs Worker only adapts Cloudflare triggers (queue, cron, workflow) to application services. Business rules
 * live in `@marketplace/marketplace`; nothing here writes to D1 directly.
 */

const indexPackageParamsSchema = z.object({
  submissionId: z.string().regex(/^sub_[0-9a-z]{26}$/),
  packageName: packageNameSchema,
});

/**
 * Cron expressions from `wrangler.jsonc` (identical in every environment). Discovery runs on its own tick; every tick,
 * including the frequent one, makes sure the default pages exist.
 */
const DISCOVERY_CRON = "17 */6 * * *";

/** Per-stage retry policy: npm and R2 hiccups are retried; a rejection (bad artifact) never is. */
const STEP_CONFIG = {
  retries: { limit: 4, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

function depsFor(env: Env): MarketplaceDeps {
  // Fail fast on misconfiguration before any work is attempted.
  parseRuntimeVars({ PUBLIC_SITE_URL: env.PUBLIC_SITE_URL, ENVIRONMENT: env.ENVIRONMENT, ADMIN_EMAILS: env.ADMIN_EMAILS });
  return createMarketplaceDeps({ d1: env.DB, queue: env.INGEST_QUEUE, media: env.MEDIA });
}

type StepOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code: IndexingRejectionCode; message: string; details: unknown };

/**
 * Runs each indexing stage as a durable `step.do`. A rejection is returned from the step as data (so the Workflow
 * does not retry it) and rethrown outside, where `indexPackage` records it once.
 */
function workflowStepRunner(step: WorkflowStep): StepRunner {
  return async <T>(name: string, run: () => Promise<T>): Promise<T> => {
    const outcome = (await step.do(name, STEP_CONFIG, async () => {
      try {
        // Stage results are JSON-serialisable by construction (see `indexPackage`).
        return { ok: true, value: (await run()) ?? null } as never;
      } catch (error) {
        if (!isIndexingRejection(error)) throw error;
        return { ok: false, code: error.code, message: error.message, details: error.details ?? null } as never;
      }
    })) as StepOutcome;
    if (!outcome.ok) throw new IndexingRejectedError(outcome.code, outcome.message, outcome.details);
    return outcome.value as T;
  };
}

export class IndexPackageWorkflow extends WorkflowEntrypoint<Env, IndexPackageParams> {
  override async run(event: Readonly<WorkflowEvent<IndexPackageParams>>, step: WorkflowStep): Promise<IndexPackageResult> {
    const params = indexPackageParamsSchema.parse(event.payload);
    return indexPackage(depsFor(this.env), params, { runStep: workflowStepRunner(step) });
  }
}

/** One Workflow instance per submission. A redelivered queue message finds the instance already running. */
async function startIndexingWorkflow(env: Env, params: IndexPackageParams): Promise<void> {
  try {
    await env.INDEX_WORKFLOW.create({ id: params.submissionId, params });
  } catch (error) {
    const existing = await env.INDEX_WORKFLOW.get(params.submissionId).catch(() => null);
    if (!existing) throw error;
  }
}

export default {
  async queue(batch, env) {
    const deps = depsFor(env);
    for (const message of batch.messages) {
      const parsed = ingestMessageSchema.safeParse(message.body);
      if (!parsed.success) {
        // Retrying cannot fix a malformed message; retries exhaust into the dead-letter queue for inspection.
        console.error(`ingest: malformed message ${message.id}`, parsed.error.issues);
        message.retry();
        continue;
      }
      try {
        await handleIngestMessage(deps, parsed.data, { startIndexing: (params) => startIndexingWorkflow(env, params) });
        message.ack();
      } catch (error) {
        console.error(`ingest: message ${message.id} (${parsed.data.type}) failed`, error);
        message.retry();
      }
    }
  },

  async scheduled(controller, env, ctx) {
    const deps = depsFor(env);
    // Every tick: a freshly deployed environment gets its landing, about and policy pages without a manual step.
    // One query when they all exist; existing pages are never touched.
    ctx.waitUntil(
      ensureDefaultPagesAsSystem(deps).then(
        (result) => {
          if (result.created.length > 0) console.info(`default pages (${controller.cron}): published ${result.created.join(", ")}`);
        },
        (error: unknown) => console.error(`default pages (${controller.cron}) failed`, error),
      ),
    );
    if (controller.cron !== DISCOVERY_CRON) return;
    ctx.waitUntil(
      discoverNpmPackages(deps).then(
        (result) =>
          console.info(
            `discovery (${controller.cron}): saw ${result.seen}, queued ${result.queued}, left ${result.pending} for the next run`,
          ),
        (error: unknown) => console.error(`discovery (${controller.cron}) failed`, error),
      ),
    );
  },
} satisfies ExportedHandler<Env, IngestMessage>;
