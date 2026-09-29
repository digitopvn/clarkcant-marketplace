# `clark-market` CLI

A command-line client for the marketplace, built on `@marketplace/sdk` (and so only on the public `/api/v1` API and
Better Auth's device flow). Source: `apps/cli`.

```sh
pnpm --filter @marketplace/cli start search clock         # from the repo
node apps/cli/bin/clark-market.mjs info @acme/clock-widget
```

## Global options

| Option | Meaning |
| --- | --- |
| `--json` | Print one JSON document per result (errors as `{"error": {code, message, status, requestId}}` on stdout) |
| `--api-url <url>` | Marketplace origin. Default: `$CLARK_MARKET_API_URL`, else production |
| `--help`, `--version` | Usage and version |

Environment variables:

- `CLARK_MARKET_API_URL` sets the default origin.
- `CLARK_MARKET_TOKEN` supplies a credential (for example a `cmk_` personal API token in CI) and takes precedence
  over the stored login.
- `CLARK_MARKET_CONFIG_DIR` overrides the config directory.

## Commands

| Command | Auth | Does |
| --- | --- | --- |
| `search <query...> [--limit n] [--category slug] [--kind kind]` | none | Full-text search |
| `info <name>` | none | Package details, facets and permissions |
| `login` | none | Device authorization: prints a URL and code, waits for approval in the browser, stores the token |
| `logout` | stored login | Ends the session server-side (best effort) and deletes the stored token |
| `whoami` | login | The account's email, role and scopes |
| `submit <name>[@version]` | `packages:submit` | Queues an npm package version for indexing |
| `publish-page <slug\|id>` | `pages:publish` (admin) | Publishes the page's latest draft, guarded by the draft revision (`If-Match`) |

`publish-page` reports `already live` when the draft is the live revision. If someone saves a newer draft between
the read and the publish, it exits with the conflict code, and nothing is published.

## Credentials

`login` stores the token in `credentials.json` inside the OS config directory:

| OS | Config directory |
| --- | --- |
| Windows | `%APPDATA%\clark-market` |
| macOS | `~/Library/Application Support/clark-market` |
| Other | `$XDG_CONFIG_HOME/clark-market` (default `~/.config/clark-market`) |

The file is keyed by API origin, created with mode `0600` in a `0700` directory, and written atomically. Device
logins carry the account's scopes except `admin`. Admin accounts still hold the page and curation scopes that
`publish-page` needs.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success |
| 1 | Unexpected error |
| 2 | Usage error: unknown command or option, or an invalid argument or `--api-url` |
| 3 | Not logged in, credential rejected, missing scope, or login denied or expired |
| 4 | Not found |
| 5 | Conflict: stale revision or idempotency clash |
| 6 | Validation failed |
| 7 | Network error: the marketplace was unreachable |

## Adding a command

Add a `program.command(...)` block in `apps/cli/src/cli.ts`:

- Call the marketplace through the `client` from `context()`, never `fetch` directly.
- Print through `print(human, data)`, so `--json` works.
- Throw `MarketplaceApiError`/`CliError` for failures; `exitCodeFor` maps them to exit codes.

Then extend `apps/cli/test/cli.test.ts`, which runs commands against the in-process API.
