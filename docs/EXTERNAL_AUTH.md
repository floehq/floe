# External Auth Provider Contract

Floe can delegate credential verification to an external HTTP endpoint. This
document describes the contract that the external verification endpoint must
implement so that the Floe SaaS layer (or any external auth service) can
plug in without reading core source code.

## Configuration

The external provider is enabled by setting:

```dotenv
FLOE_AUTH_PROVIDER=external
```

Optional tuning:

| Env var                                 | Default | Description                                                                                                 |
| --------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------- |
| `FLOE_AUTH_EXTERNAL_VERIFY_URL`         | —       | HTTPS URL of the verify endpoint (required)                                                                 |
| `FLOE_AUTH_EXTERNAL_SHARED_SECRET`      | —       | Sent as `x-floe-shared-secret` header on each verify request                                                |
| `FLOE_AUTH_EXTERNAL_AUTH_TOKEN`         | —       | Sent as `Authorization: Bearer <token>` on each verify request                                              |
| `FLOE_AUTH_EXTERNAL_TIMEOUT_MS`         | `2000`  | HTTP request timeout in milliseconds                                                                        |
| `FLOE_AUTH_EXTERNAL_CACHE_TTL_MS`       | `5000`  | How long to cache a successful verify response (in ms)                                                      |
| `FLOE_AUTH_EXTERNAL_TRUST_HEADERS`      | `false` | When `1`, skip the HTTP POST and read identity from request headers instead (see "Header-trust mode" below) |
| `FLOE_AUTH_EXTERNAL_ISSUER`             | —       | Expected issuer identifier (passed through, not currently validated)                                        |
| `FLOE_AUTH_EXTERNAL_DEFAULT_EXPIRES_AT` | —       | ISO-8601 fallback expiry timestamp when the response does not include `expiresAt`                           |

## Endpoint Contract

### `POST <verify_url>`

The Floe core sends an HTTP POST request to the configured verify URL every
time a request presents a bearer token or API key and the response is not
already cached.

#### Request Headers

```
content-type: application/json
accept: application/json
x-floe-shared-secret: <value-of-FLOE_AUTH_EXTERNAL_SHARED_SECRET>   # optional
authorization: Bearer <value-of-FLOE_AUTH_EXTERNAL_AUTH_TOKEN>      # optional
```

#### Request Body

When the client presented an `x-api-key` header:

```json
{
  "apiKey": "<the-api-key-secret>"
}
```

When the client presented an `Authorization: Bearer <token>` header:

```json
{
  "delegatedToken": "<the-bearer-token>"
}
```

The two fields are mutually exclusive for a single request.

#### Successful Response

**Status:** `200 OK`

**Body:** A JSON object with the following fields. All fields carry
semantics defined in `apps/api/src/types/auth-external.contract.ts`.

```json
{
  "valid": true,
  "subjectId": "user_abc123",
  "subjectType": "user",
  "keyId": "key_xyz",
  "orgId": "org_42",
  "projectId": "proj_7",
  "scopes": ["uploads:write", "files:read"],
  "ownerAddress": "0xf35568c562fd25dccd58e4e9240d8a6f864de0a9854ddd1f7d8aa6ff5f9722a4",
  "walletAddress": "0xabc...",
  "tier": "authenticated",
  "expiresAt": "2026-07-12T23:59:59Z"
}
```

Field reference:

| Field           | Required        | Type       | Description                                                                                                                                   |
| --------------- | --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `valid`         | semi            | `boolean`  | `true` to accept the credential. If absent, falls back to `authenticated`. If both absent or `false`, rejection.                              |
| `authenticated` | semi            | `boolean`  | Legacy fallback for `valid`. Only used when `valid` is absent.                                                                                |
| `subjectId`     | when valid=true | `string`   | Stable principal identifier. Used for rate-limit bucketing. Must be non-empty.                                                                |
| `subjectType`   | no              | `string`   | One of `user`, `api_key`, `service`, or `public`. Defaults to `user` if omitted.                                                              |
| `keyId`         | no              | `string`   | API key identifier, if applicable.                                                                                                            |
| `orgId`         | no              | `string`   | Organisation/tenant ID. Passed through to infrastructure events but not interpreted by Floe core.                                             |
| `projectId`     | no              | `string`   | Project/workspace ID. Passed through to infrastructure events but not interpreted by Floe core.                                               |
| `scopes`        | no              | `string[]` | Authorized API scopes. See known scopes below.                                                                                                |
| `ownerAddress`  | no              | `string`   | Sui wallet address for owner-based access enforcement.                                                                                        |
| `walletAddress` | no              | `string`   | Sui wallet address, if different from `ownerAddress`.                                                                                         |
| `tier`          | no              | `string`   | Rate-limit tier: `public` or `authenticated`. Defaults to `authenticated`.                                                                    |
| `expiresAt`     | no              | `string`   | ISO-8601 expiry timestamp. If in the past, treated as invalid. Caps response cache TTL.                                                       |
| `reason`        | no              | `string`   | Failure reason when `valid` is not `true`. One of: `invalid`, `expired`, `revoked`, `malformed`, `unauthorized`, `timeout`, `missing_claims`. |

#### Known Scopes

These are the scopes that Floe core checks. The external verifier should
issue any combination that matches the principal's permissions.

| Scope           | Purpose                                                 |
| --------------- | ------------------------------------------------------- |
| `uploads:write` | Create, chunk, complete, and cancel uploads             |
| `uploads:read`  | Read upload status                                      |
| `files:read`    | Read file metadata, manifest, and stream                |
| `ops:read`      | Read operator endpoints (e.g. `/ops/uploads/:uploadId`) |
| `admin:uploads` | Admin-level upload operations                           |
| `*`             | Full access (wildcard)                                  |

#### Failure Responses

Any non-`200` status OR a `200` with `valid: false` (or absent/expired):

```json
{
  "valid": false,
  "reason": "invalid"
}
```

Floe falls back to a **public (unauthenticated) identity** when verification
fails. The caller's original request is then subject to the access policy
(`FLOE_ACCESS_POLICY`) which may reject it if auth is required.

#### Caching Behaviour

1. Successful verifications are cached in-process for
   `FLOE_AUTH_EXTERNAL_CACHE_TTL_MS` (default 5000ms).
2. If the response includes `expiresAt`, the cache TTL is the _minimum_ of
   the configured TTL and the credential's remaining lifetime.
3. Failed verifications are **not** cached — every subsequent request retries
   the verification.
4. The cache key is `${credentialType}:${credentialValue}` (e.g.
   `"api_key:sk_live_abc123"`).
5. Cache is purely in-memory and per-process. Restarting a Floe instance
   clears the cache.

#### Error / Failure Semantics

| Scenario                       | Behaviour                     |
| ------------------------------ | ----------------------------- |
| HTTP timeout                   | Falls back to public identity |
| Network error                  | Falls back to public identity |
| Non-200 status                 | Falls back to public identity |
| Malformed response JSON        | Falls back to public identity |
| Missing `subjectId` when valid | Falls back to public identity |
| `expiresAt` in the past        | Falls back to public identity |
| Verifier returns 5xx           | Falls back to public identity |

## Header-trust Mode

When `FLOE_AUTH_EXTERNAL_TRUST_HEADERS=1`, Floe skips the HTTP POST
entirely and reads identity from request headers. This mode is designed
for deployments where a trusted reverse proxy (e.g., Envoy, Kong) performs
authentication and injects the resolved identity into proxied headers.

Floe reads these headers:

| Header                       | Required | Description                                                 |
| ---------------------------- | -------- | ----------------------------------------------------------- |
| `x-floe-auth-subject-id`     | yes      | Principal identifier                                        |
| `x-floe-auth-subject-type`   | no       | `user`, `api_key`, `service`, or `public` (default: `user`) |
| `x-floe-auth-expires-at`     | no       | ISO-8601 expiry. If expired, identity is rejected.          |
| `x-floe-auth-key-id`         | no       | API key identifier                                          |
| `x-floe-auth-org-id`         | no       | Organisation/tenant ID                                      |
| `x-floe-auth-project-id`     | no       | Project/workspace ID                                        |
| `x-floe-auth-scopes`         | no       | Comma-separated scope list                                  |
| `x-floe-auth-owner-address`  | no       | Sui wallet address                                          |
| `x-floe-auth-wallet-address` | no       | Sui wallet address                                          |
| `x-floe-auth-tier`           | no       | `public` or `authenticated` (default: `authenticated`)      |

**Security note:** When using header-trust mode, ensure the reverse proxy
**strips these headers** from incoming client requests so they cannot be
spoofed.

## Relation to FLOE_ACCESS_POLICY

`FLOE_AUTH_PROVIDER=external` only controls _how_ identity is resolved.
`FLOE_ACCESS_POLICY` controls _when_ authentication is required:

| Access Policy      | External auth behaviour                                       |
| ------------------ | ------------------------------------------------------------- |
| `public`           | Upload and file routes accept unauthenticated requests        |
| `hybrid` (default) | Upload routes require auth; file reads accept unauthenticated |
| `private`          | Both upload and file routes require auth                      |

When the verifier fails or the credential is invalid, the identity resolves
to `public` (unauthenticated). Whether the request is then accepted depends
on `FLOE_ACCESS_POLICY`.

## TypeScript Contract

The canonical type definitions are in:

```
apps/api/src/types/auth-external.contract.ts
```

This file exports `ExternalVerifyResponse`, `ExternalVerifyRequestBody`,
and related types. It serves as the single source of truth for the
wire format.
