# ClarkCant account linking

How a ClarkCant app (desktop, CLI or MCP client) signs in to the marketplace and optionally links its local
identity to a marketplace account. Linking is optional: a ClarkCant install keeps working with its local identity
alone, and a link never replaces or rewrites that identity.

Source of truth: `packages/auth/src/create-auth.ts` (auth configuration), `packages/api/src/routes/me.ts`
(endpoints, also in `/openapi.json`), `packages/marketplace/src/accounts/device-links.ts` (link rules).

## Credentials the API accepts

`/api/v1/*` accepts exactly one credential per request. An `Authorization` header wins over a cookie; an invalid,
expired or revoked bearer answers `401` (it never falls back to anonymous).

| Credential | How it is obtained | Scopes |
|---|---|---|
| Session cookie | Browser sign-in on `/login` | All of the account's scopes; mutations need a same-origin `Origin` (CSRF) |
| `Bearer cmk_…` personal token | Account page or `POST /api/v1/me/tokens` | The scopes chosen at creation (a subset of the account's) |
| `Bearer <OAuth access token>` (JWT) | OAuth 2.1 authorization code + PKCE | The granted OAuth scopes; never `admin` |
| `Bearer <session token>` | Device authorization flow (CLI) | The account's scopes without `admin` |

Admin authority is only available through a browser session of an allowlisted account (`ADMIN_EMAILS`) or a
`cmk_` token that such a session created with the `admin` scope. Agents get scoped tokens, never raw admin
sessions.

## Desktop and MCP clients: OAuth 2.1 + PKCE

- Discovery: `GET /api/auth/.well-known/openid-configuration` (issuer `<origin>/api/auth`). The authorization
  server metadata is also served under the issuer path.
- Registration: public clients register with RFC 7591 at `POST /api/auth/oauth2/register`
  (`token_endpoint_auth_method: "none"`). Loopback redirect URIs (`http://127.0.0.1:<port>/…`) require
  `application_type: "native"`.
- Authorization: `GET /api/auth/oauth2/authorize` with `response_type=code`, `code_challenge_method=S256`,
  `resource=<origin>/api/v1` and scopes such as `openid profile account:read account:write offline_access`.
  Signed-out users are sent to `/login`, then to the consent page `/oauth/consent`.
- Token: `POST /api/auth/oauth2/token`. The access token is a JWT with audience `<origin>/api/v1`; send it as
  `Authorization: Bearer <token>` to `/api/v1/*`.
- Users see and revoke authorized clients on the account page (`GET`/`DELETE /api/v1/me/oauth/grants`).

## CLI: device authorization (RFC 8628)

1. `POST /api/auth/device/code` with `{ "client_id": "clark-market-cli" }` (or `clarkcant-desktop`). The answer
   carries `device_code`, `user_code`, `verification_uri` (`<origin>/device`) and `interval` (5 s).
2. The user opens `/device?user_code=…`, signs in if needed, and approves.
3. The CLI polls `POST /api/auth/device/token` with
   `{ "grant_type": "urn:ietf:params:oauth:grant-type:device_code", "device_code": "…", "client_id": "…" }`
   no faster than `interval` until it receives `access_token`.
4. That `access_token` is a Better Auth **session token**. Send it as `Authorization: Bearer <token>`; it is
   valid for 7 days (sliding) and ends on sign-out or account deletion. For long-lived automation create a
   `cmk_` token instead.

## Linking a local principal

With any credential that holds `account:write`:

```http
POST /api/v1/me/devices/link
Authorization: Bearer <token>
Content-Type: application/json

{ "localPrincipalId": "prin_abc123", "deviceLabel": "Studio Mac" }
```

- `localPrincipalId` must match `prin_[A-Za-z0-9]{1,120}`; `deviceLabel` is 1–80 characters.
- Linking is idempotent per account and principal: repeating it updates the label and re-activates a previously
  unlinked principal. Uniqueness is per account: each account holds at most one link per principal.
- `GET /api/v1/me/devices` lists active links (`account:read`).
- `DELETE /api/v1/me/devices/{id}` unlinks (`account:write`, answers `204`). The link row is kept as revoked for
  the audit trail; nothing on the device changes.
- Every link and unlink writes an audit event. Deleting the account removes all links.
