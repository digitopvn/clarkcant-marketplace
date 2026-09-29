import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { ingestMessageSchema, parseRuntimeVars, packageNameSchema, type IngestMessage } from "@marketplace/contracts";
import {
  createMarketplaceDeps,
  discoverNpmPackages,
  handleIngestMessage,
  indexPackage,
  type IndexPackageParams,
  type MarketplaceDeps,
} from "@marketplace/marketplace";
import { z } from "zod";

/**
 * The jobs Worker only adapts Cloudflare triggers (queue, cron, workflow) to application services. Business rules
 * live in `@marketplace/marketplace`; nothing here writes to D1 directly.
 */

const indexPackageParamsSchema = z.object({ submissionId: z.string().min(1), packageName: packageNameSchema });

function depsFor(env: Env): MarketplaceDeps {
  // Fail fast on misconfiguration before any work is attempted.
  parseRuntimeVars({ PUBLIC_SITE_URL: env.PUBLIC_SITE_URL, ENVIRONMENT: env.ENVIRONMENT, ADMIN_EMAILS: env.ADMIN_EMAILS });
  return createMarketplaceDeps({ d1: env.DB, queue: env.INGEST_QUEUE, media: env.MEDIA });
}

export class IndexPackageWorkflow extends WorkflowEntrypoint<Env, IndexPackageParams> {
  override async run(event: Readonly<WorkflowEvent<IndexPackageParams>>, step: WorkflowStep) {
    const params = indexPackageParamsSchema.parse(event.payload);
    return step.do("index package", async () => {
      const result = await indexPackage(depsFor(this.env), params);
      return { packageId: result.packageId, version: result.version };
    });
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
        await handleIngestMessage(deps, parsed.data);
        message.ack();
      } catch (error) {
        console.error(`ingest: message ${message.id} (${parsed.data.type}) failed`, error);
        message.retry();
      }
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      discoverNpmPackages(depsFor(env)).then(
        (result) => console.info(`discovery (${controller.cron}): queued ${result.queued}`),
        (error: unknown) => console.error(`discovery (${controller.cron}) failed`, error),
      ),
    );
  },
} satisfies ExportedHandler<Env, IngestMessage>;
