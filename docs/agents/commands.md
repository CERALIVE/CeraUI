<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## COMMANDS

Functional E2E backend readiness is child-owned IPC, never a generic TCP probe.
Linux local runs lease 3100–3149 RPC slots across processes; CI keeps its existing
isolated-runner proxy range. Each acquisition owns fresh disk state and an
OS-assigned mock-preview listener. See [`docs/E2E-BACKEND-OWNERSHIP.md`](../E2E-BACKEND-OWNERSHIP.md)
and the frontend E2E playbook before changing this lifecycle.

Local Playwright also owns its run-wide Vite listener on 6173 and reference
backend on 3003. Neither reuses an existing listener: a foreign dev server on
3002 once handed an unrelated checkout's password/token state to the test
suite. Specs capture the raw E2E token during discovery; `playwright.config.ts`
seeds the sidecar before that point, and global setup adds its digest to the
worker-backend seed only after proving a genuine remember-me login. It never
rotates the captured sidecar token. CI's separate preview routing and seeded
credential path are unchanged. Local Vite-dev runs use one worker (full suite
448 pass); CI's production-preview lanes keep four, with the same test bodies,
timeouts and skip conditions.

Portal credentials use the existing mode-0600 atomic store, now written only
after successful verification in `modems.setCredentials`. Failed candidates stay
request-local on the backend and mount-local in `ModemLockSection`; failed
replacement and re-verification preserve the prior stored credential. Clearing
cancels in-flight verification. Router Configure remains reachable for login,
portal access and diagnostics independently of writable settings. Contract and
unsupported-login boundaries: [`docs/CONFIG_PERSISTENCE.md`](../CONFIG_PERSISTENCE.md).

```bash
bun install           # installs all workspaces; resolves registry deps (no sibling checkout required)
bun run dev           # frontend + backend via mprocs TUI (Vite 6173 + backend 3002)
bun run build         # compile backend binary + frontend static
bun run test:release-package-contracts   # provenance + release graph + dispatch-input security
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh   # .deb for ARM64
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh   # .deb for AMD64
bun run --filter backend check   # type-check backend via scripts/tsc.mjs + exec guards
bun run --filter frontend test   # vitest frontend unit tests
bun run build:frontend && bun apps/frontend/scripts/check-precache.mjs   # PWA precache-manifest gate
```

