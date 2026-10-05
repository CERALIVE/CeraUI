<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A REMEMBER-ME CREDENTIAL IS A REVOCABLE TOKEN, STORED AS A DIGEST [EXISTS]

`auth.procedure.ts` issues an opaque token on a persistent login and stores
`sha256(token)`; `auth.revokeToken` retires one credential or all of them, and a
password change revokes every outstanding one.

**What it replaced was two defects, not one.** The browser persisted the
operator's PLAINTEXT PASSWORD under `localStorage.auth` and resent it as
`input.password` on every reconnect — so the device's only remember-me credential
was a PERMANENT one that could not be retired without changing the password
everywhere — and `auth_tokens.json` held its tokens VERBATIM, so anything that
could read that file held a working credential for every remembered browser. The
token-login branch existed the whole time and no shipped client used it.

Six rules carry it:

- **The stored record is a DIGEST, and SHA-256 rather than a KDF.** The token is
  32 CSPRNG bytes, so there is no guessable structure for a slow hash to defend,
  and every reconnect pays this lookup. A digest makes the file a lookup table
  rather than a keyring: a leak proves which credentials exist, not what they are.
- **Pre-digest records are PRUNED on load.** They were already inert — lookup is
  keyed on the digest, which a base64 token cannot match — but leaving them keeps
  credential material on disk and makes "log out everywhere" count entries nothing
  can use. Affected browsers re-authenticate with the password once.
- **A password change revokes EVERYTHING, and re-authenticates the caller.** A
  credential issued against the old password must not outlive it, or changing the
  password after losing a device leaves that device signed in. The calling socket
  is re-issued a fresh token so the operator who just changed it is not thrown out
  — do not delete that as redundant.
- **`revokeToken` scopes explicitly** (`token` | `all`) rather than by boolean
  flag, because the two differ only in blast radius. Absent `token` means the
  caller's own; `revoked` is a COUNT, so retiring an already-gone credential
  succeeds with `0` and a consumer can tell that from a real revocation.
- **Only a socket revoking its OWN credential loses its session.** Retiring
  another browser's token must not sign the caller out.
- **It is gated in the handler, not by `authedProcedure`.** Every procedure in
  this file takes the raw context, because `setPassword` must also serve first-run
  setup.

Frontend half: [`../frontend/AGENTS.md`](../../../frontend/AGENTS.md) and the root
charter's **G3** gate. Coverage: `src/tests/auth-persistent-token.test.ts` (the
digest-not-token file assertion, the token round-trip, individual revocation, the
foreign-token and unauthenticated negatives, log-out-everywhere, logout's own
scope, and the password-change sweep).

