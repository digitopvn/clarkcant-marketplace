import type { operations } from "./generated/openapi";

/*
 * Response and request types derived from the generated OpenAPI types, named after the API's operations. They are
 * never hand-written, so the SDK cannot drift from the server contract without the drift test failing.
 */

type JsonContent<T> = T extends { content: { "application/json": infer Body } } ? Body : never;

/** JSON body of `operationId`'s response with `status`. */
export type ResponseOf<Op extends keyof operations, Status extends keyof operations[Op]["responses"]> = JsonContent<
  operations[Op]["responses"][Status]
>;

/** JSON request body of `operationId`. */
export type RequestBodyOf<Op extends keyof operations> = operations[Op] extends { requestBody?: infer Body }
  ? JsonContent<NonNullable<Body>>
  : never;

/** Query parameters of `operationId`. */
export type QueryOf<Op extends keyof operations> = operations[Op]["parameters"] extends { query?: infer Query }
  ? NonNullable<Query>
  : never;

export type Health = ResponseOf<"getHealth", 200>;
export type PackagePage = ResponseOf<"listPackages", 200>;
export type PackageSummary = PackagePage["items"][number];
export type PackageDetail = ResponseOf<"getPackage", 200>;
export type PackageVersionSummary = ResponseOf<"listPackageVersions", 200>["items"][number];
export type PackagePermission = NonNullable<PackageDetail["latest"]>["permissions"][number];
export type PackageInstall = ResponseOf<"getPackageInstall", 200>;
export type SearchResult = ResponseOf<"searchPackages", 200>;
export type SearchQuery = QueryOf<"searchPackages">;
export type ListPackagesQuery = QueryOf<"listPackages">;
export type Category = ResponseOf<"listCategories", 200>["items"][number];
export type CollectionSummary = ResponseOf<"listCollections", 200>["items"][number];
export type CollectionDetail = ResponseOf<"getCollection", 200>;
export type SubmitPackageInput = RequestBodyOf<"submitPackage">;
export type SubmitPackageResult = ResponseOf<"submitPackage", 202>;
export type Submission = ResponseOf<"getSubmission", 200>;
export type AccountProfile = ResponseOf<"getMe", 200>;
export type OwnedPackage = ResponseOf<"listMyPackages", 200>["items"][number];
export type PageSummary = ResponseOf<"listPages", 200>["items"][number];
export type PageState = ResponseOf<"getPage", 200>;
export type PatchPageResult = ResponseOf<"patchPage", 200>;
export type PageOperation = RequestBodyOf<"patchPage">["operations"][number];
export type PreviewLink = ResponseOf<"previewPage", 200>;
export type PublishedPage = Exclude<ResponseOf<"getPublishedPage", 200>, string>;
export type CurationState = ResponseOf<"featurePackage", 200>;
export type CollectionCommand = RequestBodyOf<"manageCollection">;
export type CollectionState = ResponseOf<"manageCollection", 200>;
