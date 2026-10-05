# MCP server

The marketplace serves a [Model Context Protocol](https://modelcontextprotocol.io) server at `/mcp`. It uses
stateless streamable HTTP and answers both the 2026-07-28 per-request protocol and 2025-era clients. The tools call
the same application services as the REST API (`packages/marketplace`) with the caller's `Actor`. Scopes,
validation, idempotency and audit behave the same on both surfaces.

- Code: `packages/mcp` (tool table `src/marketplace-tools.ts`, endpoint `src/mcp-endpoint.ts`, OAuth discovery
  `src/oauth-discovery.ts`), mounted by `apps/web/src/pages/mcp.ts`.
- Browser pages also expose WebMCP tools. See [WebMCP](#webmcp-in-the-browser) below.

## Authentication

| Caller | How | Tools |
| --- | --- | --- |
| Anonymous | no `Authorization` header | public read tools |
| Personal API token | `Authorization: Bearer cmk_…` (create one under Account → API tokens) | tools whose scope the token holds |
| OAuth | an access token issued by the marketplace for resource `<site>/mcp` (discovery below) | tools whose scope the grant holds; never `admin` or `account:write` |
| Device login | the session token from `clark-market login` | the account's scopes without `admin` |

Browser session cookies are ignored on `/mcp`. Without that rule, a cross-site page could drive tools with a
visitor's session.

Calling a tool that needs a scope:

- **No credential, or an invalid one:** the answer is `401` with
  `WWW-Authenticate: Bearer resource_metadata="<site>/.well-known/oauth-protected-resource/mcp", scope="…"`. An
  invalid credential also gets `error="invalid_token"`.
- **Authenticated but missing the scope:** the answer is `403` with `error="insufficient_scope"`.

MCP clients use these challenges to start or step up OAuth.

Request bodies are limited to 8 MiB (`MAX_MCP_BODY_BYTES`). A larger body, with or without `Content-Length`, is
answered `413` (`payload_too_large`) before any authentication.

Discovery documents (root-level, for MCP clients):

| URL | Content |
| --- | --- |
| `/.well-known/oauth-protected-resource` and `/.well-known/oauth-protected-resource/mcp` | RFC 9728: `resource` = `<site>/mcp`, authorization server = `<site>/api/auth` |
| `/.well-known/oauth-authorization-server` and `…/api/auth` | RFC 8414 metadata from Better Auth (dynamic client registration and PKCE) |
| `/.well-known/openid-configuration` and `…/api/auth` | OpenID Connect discovery from Better Auth |

## Tools

Read tools (everyone):

| Tool | Does |
| --- | --- |
| `search_widgets` | Full-text search with `category`, `kind`, `isolation`, `platform`, `limit` and `cursor` filters |
| `get_widget` | Package details: latest version, facets, permissions, previews and security checks |
| `get_widget_versions` | Indexed versions |
| `get_widget_permissions` | The latest version's permissions, facets, services (capabilities, egress, connection), browser tokens and resource request. Informational only; nothing is granted |
| `find_similar_widgets` | Packages sharing keywords, category or facet kind, with the reasons |
| `list_featured_widgets` | Curator-featured packages |

Account tools:

| Tool | Scope | Does |
| --- | --- | --- |
| `submit_package` | `packages:submit` | Queues an npm package version for indexing |
| `list_my_packages` | `account:read` | Packages the account or its publishers own |

Admin tools, listed only when the scope is held:

| Tool | Scope | Does |
| --- | --- | --- |
| `get_page` | `pages:write` | Draft, draft revision id and live revision of a page (by id or slug) |
| `create_page_draft` | `pages:write` | Saves a whole document as the new draft (`expectedRevisionId` required) |
| `patch_page` | `pages:write` | Applies block, SEO and layout operations atomically as one draft revision |
| `preview_page` | `pages:write` | Signed, expiring preview URL |
| `publish_page` | `pages:publish` | Publishes the current draft revision; a stale revision fails with `conflict` |
| `upload_media` | `media:write` | Base64 image (PNG, JPEG, WebP or GIF, 5 MiB max decoded); the bytes are sniffed |
| `manage_collection` | `packages:curate` | `create`, `update`, `add_item`, `remove_item`, `reorder` |
| `feature_package` | `packages:curate` | Feature or unfeature a listed package (hiding or rejecting is REST-only) |

Every write accepts `idempotencyKey`, so a retried call is applied at most once.

A failure returns an MCP tool error (`isError: true`) with `structuredContent.error.code` set to the REST API's
stable codes (`not_found`, `validation_failed`, `conflict`, `forbidden`, …). No tool installs anything:
installation happens in ClarkCant after the user reviews permissions.

## Client configuration

Replace `https://<site>` with the marketplace origin, for example
`https://marketplace.clarkcant.cc`.

**Claude:**

- Claude Code: `claude mcp add --transport http clarkcant-marketplace https://<site>/mcp`.
- Claude Desktop and claude.ai: add a custom connector with the URL `https://<site>/mcp`.
- Both run the OAuth flow when a scoped tool needs it.

**ChatGPT:** in Settings → Connectors (developer mode), add an MCP server at `https://<site>/mcp`. Choose OAuth
authentication for account or admin tools, or no authentication for read-only use.

**Cursor** (`~/.cursor/mcp.json` or `.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "clarkcant-marketplace": {
      "url": "https://<site>/mcp",
      "headers": { "Authorization": "Bearer cmk_your_token" }
    }
  }
}
```

Omit `headers` to use only the public read tools, or to let Cursor run OAuth.

## Adding a tool

1. Add an entry to `USER_TOOLS` or `ADMIN_TOOLS` in `packages/mcp/src/marketplace-tools.ts`:
   - a `name`, `title` and `description`;
   - a zod `inputSchema`;
   - `readOnly`;
   - `scope` if the tool needs a credential;
   - a `run` that calls a `packages/marketplace` service with `context.actor`.
2. Never read D1 directly from a tool. If no service exists, add one to `packages/marketplace` first, so the REST
   API can share it.
3. Extend `packages/mcp/test/mcp-endpoint.test.ts`: the listing expectations, plus a valid and an invalid call.

## WebMCP in the browser

Browsers that implement WebMCP get page-scoped tools. Registration goes through
`document.modelContext.registerTool(tool, { signal })` (or `navigator.modelContext`). It is feature-detected and
withdrawn when the page element is removed.

**Package pages** (`components/webmcp/WebmcpPackageTools.astro`):

- `get_current_package`
- `get_versions`
- `inspect_permissions`
- `find_similar_widgets`
- `open_in_clarkcant`: returns the deep link and install coordinate; it never installs.
- `copy_package_reference`

**Admin page builder** (`components/webmcp/WebmcpBuilderTools.astro`):

- `update_selected_block`
- `add_block`
- `preview_page`

The builder tools use the admin's session against the same admin API. They refuse to write while the builder has
unsaved edits, and the builder reloads the draft they saved. Tool definitions live in `packages/webmcp`.
