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
export type AuthAttempt = { kind: 'ok' } | { kind: 'rejected' } | { kind: 'cancelled' } |
  { kind: 'unreachable'; cause: 'socket-not-ready' | 'rpc-error' | 'timeout' };
export function authenticate(password: string, persistentToken: boolean, signal?: AbortSignal): Promise<AuthAttempt>;
export function authenticateWithToken(token: string): Promise<AuthAttempt>;
export async function createPassword(password: string, signal?: AbortSignal): Promise<boolean>;
export function clearAuthInteraction(): void;
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
to it and returns its boolean verdict. Settings closes the password dialog,
clears its fields and reports success only on true. A false verdict keeps the
dialog and editable fields open with the existing failure message; thrown
failures follow that same visible error path. The Auth setup caller separately
clears setup fields on refusal and never proceeds to login without true.
Explicit session clearing also best-effort revokes the token on the device.

### Sign-in interaction lifetime [EXISTS]

Layout keeps one Auth instance at a stable position during a same-document
offline takeover. Its wrapper is hidden, inert and inaccessible while the
offline page owns the screen. Password, remember choice, rejected-value equality
and the pending attempt stay private to that instance. Visibility resets to
masked on both edges. Auth's locale/theme controls unmount during takeover so
their portalled menus and focus scopes retire too; the password input stays
mounted. No password store, serialization, automatic resubmission
or second auth feed is introduced. Native input, paste, composition and autofill
continue to use the original field.

Only login drafts survive the presentation swap. Entering or leaving the
device-selected setup mode clears both fields, remember, reveal and rejection
before showing the other mode. Setup also clears on takeover and terminal
completion; a refused setup result is not success and never starts login.
Successful setup is awaited before the existing explicit login.

Auth status publication clears the interaction synchronously, including live
input properties. Explicit clear-saved-session and logout use that same local
boundary before any best-effort revocation; confirmed session expiry clears too.
`clearAuthInteraction()` retires the current abort lifetime without changing the
authenticated boolean. Attempts check that lifetime and their optional caller
signal after socket readiness and before applying a reply, persisting a token or
publishing authentication. Aborted unsent waits release their timer/subscription.
Mutable login/setup wire input is cleared immediately after the client's
synchronous serialization, and on retirement before dispatch. Only the
non-secret remember choice is needed after the reply. Setup's expected transport
failures return an unsuccessful verdict; unexpected defects propagate, with
field cleanup in the form's finally block.
Cancelled results are distinct from rejection and transport unreachability.
A sent request may still execute on the device; local retirement cannot undo it.

The auth owner handles pagehide for both persisted values and pageshow from
BFCache. Its subscriber clears the form's reactive fields and live DOM values
synchronously, even while offline. Actual Auth teardown unregisters its subscriber,
retires outstanding work and clears its fields. Notification rejection is bound
to the submitted value and retires that pending attempt; editing away hides the
error, and editing back shows it again. Loading or a transport error alone does
not clear a login draft.

The trade-off is a longer in-memory lifetime for the current login, including
while hidden. Each document has its own private interaction. A full reload,
navigation or a new tab starts blank; PWA/manual recovery that reloads the
document intentionally loses the draft. This makes no cross-tab invalidation,
password-manager storage, forensic zeroization or XSS-isolation claim. No draft
enters Web Storage, cookies, IndexedDB, URLs/history, logs, telemetry or DOM
attributes. Remember-me still stores only the device-issued token.

The real Layout/Auth behavioral matrix is `Layout.auth-draft.test.ts`; the
canonical dispatch/late-reply guards are in `auth-status.test.ts`.
`auth-draft-offline.spec.ts` covers real offline events, repeated recovery,
mobile/RTL, reload and history navigation with generated disposable input.
Credential-bearing browser capture is disabled before typing, and assertions
report equality booleans rather than secret values. Disposable browser input is
created and edited inside a page callback: no secret is passed to a recorded
fill/type/press/evaluate argument. Raw JSON/JSONL reports must be audited as
well as screenshots/traces because reporters retain action arguments even with
capture disabled. Cleanup scrubs the form before failure-context collection.
EN/es-419 user guidance must
describe the same-document scope and reload trade-off in the release that ships
this behavior, alongside the existing release documentation handoff.

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

