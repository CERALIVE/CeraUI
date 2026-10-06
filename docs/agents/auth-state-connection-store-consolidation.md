<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AUTH-STATE + CONNECTION STORE CONSOLIDATION [EXISTS]

`apps/frontend/src/lib/stores/websocket-store.svelte.ts` (528 LOC, the legacy monolithic
`getAuth`/`getStatus`/`sendAuthMessage`/`socket`/etc. wrapper) is FULLY DELETED. Its
consumers were migrated across a 4-step sequence (Wave 2) to the two stores that now
exclusively own connection and auth-mutation state:

**`apps/frontend/src/lib/rpc/subscriptions.svelte.ts`** — the SOLE `rpcClient.onMessage`
consumer (`initSubscriptions()`, called once from `main.ts`). Owns every non-auth reactive
getter (`getConfig`, `getStatus`, `getModems`, `getWifi`, `getIsStreaming`, `getNetif`, …)
plus connection-state getters (`getIsConnected`, `getConnectionState` — survive socket
replacement on reconnect; prefer these over `offline-state.svelte` in any authed
component).

**`apps/frontend/src/lib/stores/auth-status.svelte.ts`** — the SOLE auth-mutation path:

```ts
export function ingestAuth(message: LoginOutput | undefined): void;   // THE writer
export function getAuthMessage(): LoginOutput | undefined;             // THE reader
export type AuthAttempt = { kind: 'ok' } | { kind: 'rejected' } |
  { kind: 'unreachable'; cause: 'socket-not-ready' | 'rpc-error' | 'timeout' };
export function authenticate(password: string, persistentToken: boolean): Promise<AuthAttempt>;
export function authenticateWithToken(token: string): Promise<AuthAttempt>;
export async function createPassword(password: string): Promise<void>;
export const authStatusStore: { value: boolean; set(b): void; subscribe(cb) };
```

`Layout.svelte`/`Auth.svelte` call `authenticate`/`createPassword`/`getAuthMessage` —
never `sendAuthMessage`/`sendCreatePasswordMessage`/`getAuth` (those no longer exist).

`authenticate()` also owns remember-me persistence. A successful persistent
login writes the device-issued `auth_token` to `localStorage.auth` synchronously
before auth state flips, never the password; a
successful non-persistent login removes it. Server rejection is distinct from
transport unreachability: only `rejected` may make Layout/reconnect delete the
saved credential, while `unreachable` preserves it for Retry or the explicit
`clear-saved-session` escape hatch. `Auth.svelte` must not recreate a persistence
effect — it can unmount on the auth flip before such an effect runs.

`authenticateWithToken()` shares that typed lifecycle and sends `input.token`.
The device returns success without rotating the token, so a successful restore
retains it. `createPassword()` clears the old credential after confirmed success,
matching the device's all-token revocation; `SystemHelper.savePassword()` delegates
to it. Explicit session clearing also best-effort revokes the token on the device.

**The rule for all future frontend work:** ONLY `subscriptions.svelte.ts` (non-auth
reactive state + connection state) and `auth-status.svelte.ts` (auth mutation state) own
connection/auth state. Do not add a second `rpcClient.onMessage` owner or a parallel
auth-mutation path. A CI grep gate
(`apps/frontend/src/tests/deprecated-ws-store-gate.test.ts`) fails the build if the literal
`websocket-store` module name reappears anywhere in `apps/frontend/src` — re-introducing a
legacy WS bridge is therefore a deliberate, visible decision, never a silent import.

**`offline-state.svelte.ts` / `pwa-status.svelte` read connection state from `$lib/rpc/client`
directly** (`rpcClient.getConnectionState()` + `onConnectionChange`) — NOT from
`subscriptions.svelte` — to stay pre-auth-pure (no subscription graph pulled before login).
This is the one deliberate exception to "read connection state from subscriptions.svelte",
not drift. `offline-state.svelte.ts` additionally imports `connection-ux.svelte.ts` for the
ONE shared reconnect-grace verdict (`getDisconnectedSince` / `getHasConnected` /
`getGraceNow` / `hasOutlastedBannerGrace`); that store reads the same client surface
directly, so the pre-auth purity is preserved and the full-page offline takeover can no
longer disagree with the smaller banners about how long a drop has lasted. After an
established connection, a socket-only loss remains banner-owned while the browser is
online; the takeover is reserved for browser-offline recovery so its origin poll cannot
reload a healthy page. Do NOT give
`offline-state` a second offline detector or a second grace constant — see
[`apps/frontend/AGENTS.md`](../../apps/frontend/AGENTS.md) → "Reconnect-surface grace period".

