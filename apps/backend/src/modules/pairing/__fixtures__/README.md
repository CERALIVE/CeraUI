# Signed-path fixtures (Task 21)

Wire-contract fixtures for the **end-to-end signed path**: the platform
(`ceralive-platform`) SIGNS a device-control PASETO `v4.public` token, and this
device VERIFIES it with the independent `node:crypto` verifier in
[`../paseto-v4.ts`](../paseto-v4.ts). These fixtures are consumed by
[`../../../tests/signed-path-fixtures.test.ts`](../../../tests/signed-path-fixtures.test.ts).

They are the **contract**, not a shared module — the platform and device crypto
stacks are different implementations (`paseto-ts` vs `node:crypto`), and proving
the same bytes verify on both is the cross-repo interop guarantee (Rule D).

## Files

| File | Contents |
|------|----------|
| `test-public-key.txt` | Ed25519 public key, PASERK `k4.public.…` format (the platform encoding). The device test strips the `k4.public.` prefix to get the raw-base64url key its `PASETO_PUBLIC_KEY` env expects. |
| `valid-device-control-token.txt` | Validly-signed `purpose: device-control` token. Spans `[iat, iat+15min]`. |
| `wrong-purpose-relay-config-token.txt` | Validly-signed `purpose: relay-config` token — rejected by the purpose gate, never by signature. |
| `expired-device-control-token.txt` | Validly-signed `device-control` token whose `exp` is 15 min before the frozen clock. |

## No private key in git

These fixtures were generated **once** with a **THROWAWAY** Ed25519 keypair (NOT
the production signing key). Only the **public key** and the **3 signed tokens**
are committed — the private/secret key was generated in-process and discarded, and
never written to disk or the repository.

## Frozen clock

The tokens carry integer epoch-second `iat`/`exp` baked around a fixed instant:
`iat = 1_750_000_000` (epoch seconds). The device test freezes its clock at
`1_750_000_000_000` ms and passes it as the injected `now` to
`verifyDeviceControlToken(token, now)` — so the ±30s window is deterministic and
never time-flaky. `Date.now()` is never on the tested path.
