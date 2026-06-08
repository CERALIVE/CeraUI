# Kiosk Token Contract

**Status:** `[EXISTS]`
**Scope:** CeraUI backend + image-building-pipeline `kiosk.service`
**Design contract:** DC-3

This document is the single source of truth for the loopback kiosk-token interface. Both the CeraUI backend (Task 24) and the image kiosk service (Task 26) are built to this spec. Any change here must be reflected in both repos in the same change (Rule A).

---

## Overview

When the kiosk service launches Chromium, it needs to open the CeraUI web UI already authenticated, without prompting the user for a password. The mechanism is a short-lived, single-use token that the backend mints at kiosk-service start, writes to a tmpfs path, and accepts exactly once in exchange for a session cookie.

The token is:
- 32 bytes of cryptographic randomness, hex-encoded (64 hex characters)
- Written only to tmpfs (`/run/`) — never to durable disk
- Consumed over loopback only — LAN requests are rejected
- Single-use: the first valid exchange invalidates it immediately
- Not a PASETO token and not related to the device-token claim contract

---

## Fixed Loopback Port

```
CERAUI_BACKEND_PORT = 80
```

The CeraUI backend production HTTP port is **80**. This is the first entry in the production port list in `apps/backend/src/rpc/server.ts`:

```typescript
// apps/backend/src/rpc/server.ts
const ports: number[] =
    process.env.NODE_ENV === "development"
        ? [3002, 8080, 8081]
        : [80, 8080, 81];   // ← 80 is the production primary
```

The kiosk URL is therefore:

```
http://127.0.0.1:80/?mode=touch&display=<profile>&kiosk_token=<token>
```

Both repos consume this constant. Neither may hardcode a different port or derive it independently.

---

## Token Specification

| Property | Value |
|----------|-------|
| Entropy | 32 bytes (`crypto.getRandomValues`) |
| Encoding | lowercase hex (64 characters) |
| Format | `[0-9a-f]{64}` |
| Lifetime | single-use; invalidated on first valid exchange |
| Storage | tmpfs only (`/run/ceralive/kiosk-token`) |
| Transport | URL query parameter `kiosk_token` |

### Why hex, not base64

The token is embedded in a shell `ExecStart=` line and passed as a URL query parameter. Hex is unambiguous in both contexts. The `randomBase64` helper in `apps/backend/src/helpers/crypto.ts` produces base64; the kiosk token uses `crypto.getRandomValues` directly and encodes with `Buffer.from(buf).toString("hex")` instead.

### What this is NOT

- Not a PASETO v4.public token (see `packages/rpc/src/schemas/pairing.schema.ts` for the device-token contract)
- Not a claim code (see `CLAIM_CODE_ALPHABET` in the same file)
- Not a session cookie — it is exchanged for one
- Not durable — it does not survive a backend restart

---

## tmpfs Path

```
/run/ceralive/kiosk-token
```

`/run` is a tmpfs mount on all systemd-based Linux systems. Files written here are lost on reboot and are never flushed to disk. The directory `/run/ceralive/` must be created by the backend (or a `RuntimeDirectory=ceralive` directive in the unit file) before the token is written.

File contents: the 64-character hex token, no trailing newline.

```
# example file contents
a3f8c2e1d4b7a09f6e5c3d2b1a0f9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2
```

File permissions: `0600`, owned by the user the backend runs as (typically `ceralive` or `root`).

---

## Exchange Flow

The exchange happens over a single HTTP GET request. The backend validates the token, sets a session cookie, and invalidates the token before returning the response.

```
kiosk.service                    CeraUI backend
     |                                |
     |  mint token → write to tmpfs   |
     |                                |
     |  ExecStart: chromium           |
     |    http://127.0.0.1:80/        |
     |    ?mode=touch                 |
     |    &display=lcd                |
     |    &kiosk_token=<hex>          |
     |                                |
     |  GET /?...&kiosk_token=<hex>   |
     |------------------------------->|
     |                                | 1. Check source IP == 127.0.0.1
     |                                | 2. Read token from /run/ceralive/kiosk-token
     |                                | 3. Constant-time compare
     |                                | 4. Invalidate token (delete file or zero memory)
     |                                | 5. Issue session cookie
     |  200 + Set-Cookie: session=... |
     |<-------------------------------|
     |                                |
     |  All subsequent WS/HTTP reqs   |
     |  carry the session cookie      |
     |------------------------------->|
```

### Step-by-step

1. **Backend startup**: on init, the backend generates a 32-byte random token, hex-encodes it, and writes it to `/run/ceralive/kiosk-token` with permissions `0600`.

2. **kiosk.service ExecStart**: the image-side unit reads the token from `/run/ceralive/kiosk-token` and appends `&kiosk_token=<token>` to the Chromium launch URL (see [Image-side ExecStart Contract](#image-side-execstart-contract) below).

3. **First request**: Chromium opens the URL. The backend receives the GET request.

4. **Loopback check**: the backend inspects the remote IP. If it is not `127.0.0.1`, it returns `401 Unauthorized` immediately without reading the token file.

5. **Token validation**: the backend reads `/run/ceralive/kiosk-token`, performs a constant-time comparison against the `kiosk_token` query parameter.

6. **Invalidation**: the token is invalidated immediately — the file is deleted (or overwritten with zeros) — before the response is sent. This happens regardless of whether the comparison succeeded.

7. **Session issuance**: on a valid match, the backend sets a `session` cookie (same mechanism as password-based login) and returns `200`.

8. **Rejection on reuse**: any subsequent request carrying the same `kiosk_token` value finds no token file and returns `401 Unauthorized`.

---

## Error Responses

| Condition | HTTP status | Body |
|-----------|-------------|------|
| Request from non-loopback IP | `401 Unauthorized` | `{"error":"loopback_only"}` |
| Token already used (file absent) | `401 Unauthorized` | `{"error":"token_invalid"}` |
| Token mismatch | `401 Unauthorized` | `{"error":"token_invalid"}` |
| Token file unreadable | `401 Unauthorized` | `{"error":"token_invalid"}` |
| `kiosk_token` param absent | ignored (normal auth flow) | — |

All 401 responses from the kiosk-token path use the same `token_invalid` body for mismatch and reuse — no oracle distinguishing the two.

---

## Image-side ExecStart Contract

The image `kiosk.service` unit is responsible for:

1. Waiting until the CeraUI backend is ready (e.g. `After=ceraui.service`, `ExecStartPre` health check against `http://127.0.0.1:80/status`).

2. Reading the token from the tmpfs path:

```bash
KIOSK_TOKEN=$(cat /run/ceralive/kiosk-token)
```

3. Constructing the launch URL with the token appended:

```bash
KIOSK_URL="http://127.0.0.1:80/?mode=touch&display=${DISPLAY_PROFILE:-lcd}&kiosk_token=${KIOSK_TOKEN}"
```

4. Launching Chromium in kiosk mode:

```bash
ExecStart=/usr/bin/chromium \
  --kiosk \
  --ozone-platform=wayland \
  --no-sandbox \
  "${KIOSK_URL}"
```

The unit must not cache or log the token value. The token is consumed on first use; if Chromium crashes and relaunches, the backend must mint a fresh token (or the kiosk service must restart the backend to trigger a fresh mint).

### Port constant

The port `80` is fixed. The image unit must not derive it from any other source. If the port ever changes, this document and `apps/backend/src/rpc/server.ts` are updated together, and the image unit is updated in the same change.

---

## Security Properties

**Loopback-only enforcement**: the backend checks the remote IP on every kiosk-token exchange request. A request arriving from any IP other than `127.0.0.1` returns `401` without touching the token file. This means a device on the LAN cannot use the kiosk token even if it somehow learns the value.

**Single-use**: the token file is deleted before the response is sent. There is no window where a second request could race the deletion and succeed — the invalidation is synchronous with the response path.

**tmpfs-only**: `/run` is a tmpfs mount. The token is never written to the eMMC, SD card, or any durable storage. It does not appear in logs, config files, or crash dumps.

**Not PASETO**: the kiosk token has no claims, no signature, and no expiry field. It is raw entropy. The PASETO device-token contract (`deviceTokenClaimsSchema` in `packages/rpc/src/schemas/pairing.schema.ts`) is a separate, unrelated mechanism for cloud pairing.

**No logging**: the token value must not appear in any log output. Log lines may record that a kiosk-token exchange occurred (success or failure) but must not include the token itself.

---

## Invariants (both repos must uphold)

- `127.0.0.1` is the only accepted source IP for kiosk-token exchanges
- The tmpfs path is exactly `/run/ceralive/kiosk-token`
- The query parameter name is exactly `kiosk_token`
- The token is invalidated before the response is returned (not after)
- The token is single-use: reuse returns `401`
- The token is not PASETO and carries no structured claims
- The token is never written to durable disk
- The loopback port is `80`
