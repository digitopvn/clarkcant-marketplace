import { createRoute, z } from "@hono/zod-openapi";
import { ANONYMOUS_ACTOR, errorBodySchema, submissionSchema, submitPackageInputSchema } from "@marketplace/contracts";
import { getSubmission, submitPackage } from "@marketplace/marketplace";

import { createRouter } from "../http/router";

/*
 * Package submissions. Handlers translate HTTP into `submitPackage` / `getSubmission`, which own scopes
 * (`packages:submit`), deduplication, idempotency and audit. Indexing itself runs in the jobs Worker.
 */

const ERROR_DESCRIPTIONS = {
  400: "Invalid package name or version (`validation_failed`)",
  401: "No credential (`unauthorized`)",
  403: "Missing `packages:submit` scope or cross-site request (`forbidden`)",
  404: "Submission not found, or not visible to the caller",
  409: "A request with this Idempotency-Key is still running (`idempotency_in_progress`)",
  422: "Idempotency-Key reused with a different request (`idempotency_key_reused`)",
  500: "Server error, including a missing ingest queue binding (`configuration_error`)",
} as const;
type ErrorStatus = keyof typeof ERROR_DESCRIPTIONS;

function errors(...statuses: ErrorStatus[]) {
  return Object.fromEntries(
    statuses.map((status) => [
      status,
      { description: ERROR_DESCRIPTIONS[status], content: { "application/json": { schema: errorBodySchema } } },
    ]),
  ) as Record<ErrorStatus, { description: string; content: { "application/json": { schema: typeof errorBodySchema } } }>;
}

const submitResultSchema = z
  .object({
    submission: submissionSchema,
    /** False when an identical submission was already queued or indexing and is returned instead. */
    created: z.boolean(),
  })
  .openapi("SubmitPackageResult");

const submitRoute = createRoute({
  method: "post",
  path: "/publish/submit",
  operationId: "submitPackage",
  tags: ["publish"],
  summary: "Ask the marketplace to index an npm package version (`packages:submit`)",
  description:
    "Queues indexing of `name@version` (or the `latest` dist-tag when `version` is omitted). Idempotent: an open " +
    "submission for the same name and version is returned rather than duplicated, and `Idempotency-Key` replays " +
    "the first response. Poll `GET /publish/submissions/{id}` for the outcome.",
  request: {
    headers: z.object({
      "idempotency-key": z
        .string()
        .min(1)
        .max(255)
        .optional()
        .openapi({ description: "Makes retries safe; replayed for 24 hours" }),
    }),
    body: { required: true, content: { "application/json": { schema: submitPackageInputSchema } } },
  },
  responses: {
    202: { description: "Accepted for indexing", content: { "application/json": { schema: submitResultSchema } } },
    ...errors(400, 401, 403, 409, 422, 500),
  },
});

const getSubmissionRoute = createRoute({
  method: "get",
  path: "/publish/submissions/{id}",
  operationId: "getSubmission",
  tags: ["publish"],
  summary: "Status of one submission (visible to its submitter and to curators)",
  request: {
    params: z.object({
      id: z
        .string()
        .min(1)
        .max(64)
        .openapi({ param: { name: "id", in: "path" }, example: "sub_01k6abcdefghjkmnpqrstvwxyz" }),
    }),
  },
  responses: {
    200: { description: "Submission", content: { "application/json": { schema: submissionSchema } } },
    ...errors(400, 401, 404, 500),
  },
});

export function createPublishRouter() {
  return createRouter()
    .openapi(submitRoute, async (c) => {
      const key = c.req.valid("header")["idempotency-key"];
      const result = await submitPackage(
        c.var.context.deps,
        c.var.actor ?? ANONYMOUS_ACTOR,
        c.req.valid("json"),
        key ? { idempotencyKey: key } : {},
      );
      return c.json(result, 202);
    })
    .openapi(getSubmissionRoute, async (c) => {
      c.header("Cache-Control", "private, no-store");
      const submission = await getSubmission(c.var.context.deps, c.var.actor ?? ANONYMOUS_ACTOR, c.req.valid("param").id);
      return c.json(submission, 200);
    });
}
