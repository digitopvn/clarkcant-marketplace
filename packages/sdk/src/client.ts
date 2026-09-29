import createClient, { type Client, type Middleware } from "openapi-fetch";

import { MarketplaceApiError, errorFromResponse, networkError } from "./errors";
import type { paths } from "./generated/openapi";
import { findSimilarPackages, type SimilarPackage } from "./similar-packages";
import type {
  AccountProfile,
  Category,
  CollectionCommand,
  CollectionDetail,
  CollectionState,
  CollectionSummary,
  CurationState,
  Health,
  ListPackagesQuery,
  OwnedPackage,
  PackageDetail,
  PackageInstall,
  PackagePage,
  PackageSummary,
  PackageVersionSummary,
  PageOperation,
  PageState,
  PageSummary,
  PatchPageResult,
  PreviewLink,
  PublishedPage,
  SearchQuery,
  SearchResult,
  SubmitPackageInput,
  SubmitPackageResult,
  Submission,
} from "./types";

export const API_PREFIX = "/api/v1";

/** A bearer credential, or a function resolving one per request (e.g. read from a token store). */
export type TokenSource = string | undefined | (() => string | undefined | Promise<string | undefined>);

export interface MarketplaceClientOptions {
  /** Site origin, e.g. `https://marketplace.example` (no `/api/v1`). */
  baseUrl: string;
  /** `cmk_…` API token, OAuth access token or device-flow session token. Omit for anonymous reads. */
  token?: TokenSource;
  /** Custom fetch (tests, in-process hosts). Defaults to `globalThis.fetch`. */
  fetch?: (request: Request) => Promise<Response>;
  /** Browser use: `"same-origin"` sends the session cookie to the site's own API. */
  credentials?: "include" | "omit" | "same-origin";
  /** Extra headers on every request (e.g. `User-Agent` in Node). */
  headers?: Record<string, string>;
}

/** Per-call options for mutating requests. */
export interface WriteOptions {
  /** Replayed for 24 hours. Generated per call when omitted, so a retried call object never applies twice. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

const IDEMPOTENT_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new MarketplaceApiError({ code: "bad_request", message: `invalid base URL: ${value}`, status: 0 });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new MarketplaceApiError({ code: "bad_request", message: `base URL must be http(s): ${value}`, status: 0 });
  }
  return url.origin;
}

async function resolveToken(source: TokenSource): Promise<string | undefined> {
  const value = typeof source === "function" ? await source() : source;
  return value && value.trim() ? value.trim() : undefined;
}

function randomKey(): string {
  return crypto.randomUUID();
}

/** ETag values are quoted revision ids (`"rev_…"`); the API accepts either form in `If-Match`. */
function quoteEtag(revisionId: string): string {
  return revisionId.startsWith('"') ? revisionId : `"${revisionId}"`;
}

interface FetchResult<T> {
  data?: T;
  error?: unknown;
  response: Response;
}

/**
 * Typed client for the marketplace REST API (`/api/v1`). Methods return the response body on success and throw
 * `MarketplaceApiError` otherwise. Every write carries an `Idempotency-Key` (generated unless given) and page edits
 * carry `If-Match`, so retries are safe and stale edits fail with `conflict` instead of overwriting.
 *
 * `raw` exposes the underlying `openapi-fetch` client, typed for every documented operation.
 */
export class MarketplaceClient {
  readonly baseUrl: string;
  readonly raw: Client<paths>;

  constructor(options: MarketplaceClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImpl = options.fetch ?? ((request: Request) => globalThis.fetch(request));
    this.raw = createClient<paths>({
      baseUrl: this.baseUrl,
      fetch: async (request) => {
        try {
          return await fetchImpl(request);
        } catch (error) {
          throw networkError(error);
        }
      },
      ...(options.credentials ? { credentials: options.credentials } : {}),
      headers: { accept: "application/json", ...options.headers },
    });
    const token = options.token;
    const auth: Middleware = {
      async onRequest({ request }) {
        const bearer = await resolveToken(token);
        if (bearer && !request.headers.has("authorization")) request.headers.set("authorization", `Bearer ${bearer}`);
        if (IDEMPOTENT_METHODS.has(request.method) && !request.headers.has("idempotency-key")) {
          request.headers.set("idempotency-key", randomKey());
        }
        return request;
      },
    };
    this.raw.use(auth);
  }

  private async unwrap<T>(call: Promise<FetchResult<T>>): Promise<T> {
    let result: FetchResult<T>;
    try {
      result = await call;
    } catch (error) {
      if (error instanceof MarketplaceApiError) throw error;
      throw networkError(error);
    }
    const { data, error, response } = result;
    if (!response.ok) throw errorFromResponse(response, error);
    if (data === undefined) {
      throw new MarketplaceApiError({
        code: "invalid_response",
        message: `expected a JSON body from ${new URL(response.url || this.baseUrl).pathname}`,
        status: response.status,
        requestId: response.headers.get("x-request-id") ?? undefined,
      });
    }
    return data;
  }

  private static writeHeaders(options: WriteOptions | undefined, ifMatch?: string) {
    const headers: Record<string, string> = {};
    if (options?.idempotencyKey) headers["idempotency-key"] = options.idempotencyKey;
    if (ifMatch) headers["if-match"] = quoteEtag(ifMatch);
    return headers;
  }

  // --- System -------------------------------------------------------------------------------------------------

  health(): Promise<Health> {
    return this.unwrap(this.raw.GET("/api/v1/health"));
  }

  // --- Packages and search ------------------------------------------------------------------------------------

  search(query: SearchQuery = {}): Promise<SearchResult> {
    return this.unwrap(this.raw.GET("/api/v1/search", { params: { query } }));
  }

  listPackages(query: ListPackagesQuery = {}): Promise<PackagePage> {
    return this.unwrap(this.raw.GET("/api/v1/packages", { params: { query } }));
  }

  getPackage(name: string): Promise<PackageDetail> {
    return this.unwrap(this.raw.GET("/api/v1/packages/{name}", { params: { path: { name } } }));
  }

  async listPackageVersions(name: string): Promise<PackageVersionSummary[]> {
    const body = await this.unwrap(this.raw.GET("/api/v1/packages/{name}/versions", { params: { path: { name } } }));
    return body.items;
  }

  getPackageInstall(name: string, version?: string): Promise<PackageInstall> {
    return this.unwrap(
      this.raw.GET("/api/v1/packages/{name}/install", { params: { path: { name }, query: version ? { version } : {} } }),
    );
  }

  /** Featured listings (curated), newest first. */
  async listFeaturedPackages(limit = 10): Promise<PackageSummary[]> {
    return (await this.listPackages({ curation: "featured", limit })).items;
  }

  /** Packages sharing keywords, category or facet kind with `name` (full-text heuristic). */
  async findSimilarPackages(name: string, limit = 5): Promise<SimilarPackage<PackageSummary>[]> {
    const source = await this.getPackage(name);
    return findSimilarPackages(source, (query) => this.search(query), limit);
  }

  // --- Catalog ------------------------------------------------------------------------------------------------

  async listCategories(): Promise<Category[]> {
    return (await this.unwrap(this.raw.GET("/api/v1/categories"))).items;
  }

  async listCollections(): Promise<CollectionSummary[]> {
    return (await this.unwrap(this.raw.GET("/api/v1/collections"))).items;
  }

  getCollection(slug: string): Promise<CollectionDetail> {
    return this.unwrap(this.raw.GET("/api/v1/collections/{slug}", { params: { path: { slug } } }));
  }

  // --- Publishing ---------------------------------------------------------------------------------------------

  submitPackage(input: SubmitPackageInput, options?: WriteOptions): Promise<SubmitPackageResult> {
    return this.unwrap(
      this.raw.POST("/api/v1/publish/submit", {
        body: input,
        params: { header: {} },
        headers: MarketplaceClient.writeHeaders(options),
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    );
  }

  getSubmission(id: string): Promise<Submission> {
    return this.unwrap(this.raw.GET("/api/v1/publish/submissions/{id}", { params: { path: { id } } }));
  }

  // --- Account ------------------------------------------------------------------------------------------------

  me(): Promise<AccountProfile> {
    return this.unwrap(this.raw.GET("/api/v1/me"));
  }

  async listMyPackages(): Promise<OwnedPackage[]> {
    return (await this.unwrap(this.raw.GET("/api/v1/me/packages"))).items;
  }

  // --- Pages (admin) ------------------------------------------------------------------------------------------

  async getPublishedPage(slug: string): Promise<PublishedPage> {
    const body = await this.unwrap(this.raw.GET("/api/v1/pages/{slug}", { params: { path: { slug }, query: { format: "json" } } }));
    if (typeof body === "string") {
      throw new MarketplaceApiError({ code: "invalid_response", message: "expected the JSON page document", status: 200 });
    }
    return body;
  }

  async listPages(): Promise<PageSummary[]> {
    return (await this.unwrap(this.raw.GET("/api/v1/admin/pages"))).items;
  }

  getPage(pageId: string): Promise<PageState> {
    return this.unwrap(this.raw.GET("/api/v1/admin/pages/{pageId}", { params: { path: { pageId } } }));
  }

  /** Applies operations atomically as one new draft revision based on `expectedRevisionId`. */
  patchPage(pageId: string, expectedRevisionId: string, operations: PageOperation[], options?: WriteOptions): Promise<PatchPageResult> {
    return this.unwrap(
      this.raw.PATCH("/api/v1/admin/pages/{pageId}", {
        params: { path: { pageId }, header: {} },
        headers: MarketplaceClient.writeHeaders(options, expectedRevisionId),
        body: { operations },
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    );
  }

  /** Makes `revisionId` (normally the current draft) live. Fails with `conflict` if the draft moved on. */
  publishPage(pageId: string, revisionId: string, options?: WriteOptions): Promise<PageState> {
    return this.unwrap(
      this.raw.POST("/api/v1/admin/pages/{pageId}/publish", {
        params: { path: { pageId }, header: {} },
        headers: MarketplaceClient.writeHeaders(options, revisionId),
        body: {},
        ...(options?.signal ? { signal: options.signal } : {}),
      }),
    );
  }

  previewPage(pageId: string, input: { revisionId?: string; ttlSeconds?: number } = {}): Promise<PreviewLink> {
    return this.unwrap(this.raw.POST("/api/v1/admin/pages/{pageId}/preview", { params: { path: { pageId } }, body: input }));
  }

  // --- Curation -----------------------------------------------------------------------------------------------

  featurePackage(name: string, featured: boolean, options?: WriteOptions): Promise<CurationState> {
    return this.unwrap(
      this.raw.POST("/api/v1/curation/packages/{name}/featured", {
        params: { path: { name }, header: {} },
        headers: MarketplaceClient.writeHeaders(options),
        body: { featured },
      }),
    );
  }

  manageCollection(slug: string, command: CollectionCommand, options?: WriteOptions): Promise<CollectionState> {
    return this.unwrap(
      this.raw.POST("/api/v1/curation/collections/{slug}", {
        params: { path: { slug }, header: {} },
        headers: MarketplaceClient.writeHeaders(options),
        body: command,
      }),
    );
  }
}

export function createMarketplaceClient(options: MarketplaceClientOptions): MarketplaceClient {
  return new MarketplaceClient(options);
}
