import { z } from "zod";

/**
 * Structural validation for the JSON-LD this site emits. It encodes the properties search engines require for each
 * type we use (schema.org vocabulary, Google rich-result requirements where they apply), so a builder change that
 * drops a required field or emits a relative URL fails tests instead of silently losing rich results.
 */
const absoluteUrl = z.url({ protocol: /^https?$/ });
const text = z.string().trim().min(1);
const isoDate = z.iso.datetime({ offset: true }).or(z.iso.date());

const listItem = z.looseObject({ "@type": z.literal("ListItem"), position: z.int().min(1) });

function consecutivePositions(items: readonly { position: number }[], ctx: z.RefinementCtx): void {
  items.forEach((item, index) => {
    if (item.position !== index + 1) {
      ctx.addIssue({ code: "custom", message: `itemListElement[${index}].position must be ${index + 1}` });
    }
  });
}

const nodeSchemas: Record<string, z.ZodType> = {
  WebSite: z.looseObject({ name: text, url: absoluteUrl }),
  WebPage: z.looseObject({ name: text, url: absoluteUrl }),
  Organization: z.looseObject({ name: text, url: absoluteUrl.optional() }),
  Person: z.looseObject({ name: text, url: absoluteUrl.optional() }),
  SoftwareSourceCode: z.looseObject({
    name: text,
    url: absoluteUrl,
    codeRepository: absoluteUrl.optional(),
    dateModified: isoDate.optional(),
    targetProduct: z.looseObject({ "@type": z.literal("SoftwareApplication"), name: text }).optional(),
  }),
  SoftwareApplication: z.looseObject({ name: text }),
  TechArticle: z.looseObject({ headline: text.max(110), url: absoluteUrl, dateModified: isoDate.optional() }),
  ItemList: z
    .looseObject({ itemListElement: z.array(listItem.extend({ url: absoluteUrl, name: text.optional() })) })
    .superRefine((value, ctx) => consecutivePositions(value.itemListElement, ctx)),
  // Google's breadcrumb rich result needs a trail of at least two items.
  BreadcrumbList: z
    .looseObject({ itemListElement: z.array(listItem.extend({ name: text, item: absoluteUrl })).min(2) })
    .superRefine((value, ctx) => consecutivePositions(value.itemListElement, ctx)),
  FAQPage: z.looseObject({
    mainEntity: z
      .array(
        z.looseObject({
          "@type": z.literal("Question"),
          name: text,
          acceptedAnswer: z.looseObject({ "@type": z.literal("Answer"), text }),
        }),
      )
      .min(1),
  }),
};

export const SUPPORTED_JSON_LD_TYPES = Object.keys(nodeSchemas);

export interface JsonLdIssue {
  path: string;
  message: string;
}

/** Validates one top-level JSON-LD node. Returns an empty list when it is valid. */
export function validateJsonLd(node: unknown): JsonLdIssue[] {
  const envelope = z.looseObject({ "@context": z.literal("https://schema.org"), "@type": z.string() }).safeParse(node);
  if (!envelope.success) return envelope.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
  const type = envelope.data["@type"];
  const schema = nodeSchemas[type];
  if (!schema) return [{ path: "@type", message: `unsupported type "${type}"` }];
  const result = schema.safeParse(node);
  if (result.success) return [];
  return result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message }));
}
