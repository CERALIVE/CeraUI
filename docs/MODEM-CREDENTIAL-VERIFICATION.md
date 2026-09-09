# Credential persistence verification — 2026-09-08

The verify-before-save change retains the existing mode-0600 modem credential
store. Its contract and protocol limitations are in
[`CONFIG_PERSISTENCE.md`](CONFIG_PERSISTENCE.md#credentials).

## Capability-absence finding

The router-dialog expectation in `truthfulness.spec.ts` was stale, not a GPS
rendering regression. `RouterDongleDialog` explicitly consumes modem-owned GPS
claims regardless of dialog family; `ModemGpsSection.test.ts` already requires
that behavior. The neighboring E2E case also requires a certified router claim
with an unavailable GPS read to remain **blocked with a reason**.

The captured ZTE summary reports `gps: implemented`, not `capable` or
`certified`. That means the build contains the module; it does not establish
this router's GPS capability. Its honest rendering is the unknown diagnostic,
with no toggle. Router IDs currently cannot complete the MM-owned GPS read;
the real refusal must not be presented as a successful reading.

The corrected browser case uses the captured ZTE row and exercises the complete
claim ladder. Absent/unavailable still requires zero section, toggle and unknown
nodes; implemented/enabled requires the unknown diagnostic and no toggle;
capable/certified requires the offered or blocked surface. The unmanaged row's
disabled Configure and the router's missing FCC/USB-mutation surfaces remain
asserted. No production GPS gate or assertion timeout was changed.

## Authentication setup

The previously reported disabled-submit failure occurred before any login RPC.
Neither the login schema, auth store, Auth component, nor E2E authentication
fixture changed in this fix. In particular, the hypothesis that an ordinary
status update clears `Auth.password` is unsupported: the status effect changes
the first-run mode, not the password. A masked password in an ARIA snapshot is
not evidence of an empty DOM input.

The lifecycle case passed the initial reproduction attempt, all three repeated
focused runs, the production-preview focused run, and the full production run.
Its exact historical disabled-submit cause was **not reproduced or proven**.
No retry loop, forced click, auth bypass, or speculative product fix was added.

## Full-run comparison

Baseline: commit `99283cf5`, with all uncommitted tracked and untracked work
stashed and subsequently restored. The five earlier integration commits were
preserved. Node 26.7.0 and Bun 1.4.2 were used for browser and application tests.

| Run | Passed | Failed | Skipped | Not run |
|---|---:|---:|---:|---:|
| Historical R3 local development run | 407 | 19 | 276 | 2 |
| Clean-base local development run, 8 workers | 408 | 17 | 274 | 1 |
| Final R3 production-preview run, 4 workers, **zero retries** | **426** | **0** | **278** | **0** |

The final run used the existing CI routing path, not a new test backdoor:

```sh
E2E_PASSWORD=12345678 bun scripts/ci/seed-e2e-auth.ts
CI=true VITE_DEVICE_HOST=127.0.0.1 VITE_DEVICE_PORT=3002 \
  bun run --filter frontend preview -- --port 6173
# In another terminal, with the preview running:
CI=true bun run test:e2e --workers=4 --retries=0 --reporter=line \
  --global-timeout=1200000
```

The password above is the repository's public test-only fixture, never a board
credential. All backend traffic uses isolated local mock workers. The existing
functional tag exclusions and conditional skips were unchanged. Production/CI
mode adds its existing development-only skips; skipped hardware cases are not
hardware passes.

### Attribution of the historical 19 failures

| Historical cases | Evidence and disposition |
|---|---|
| `autostart-toggle` ON/OFF and failure; `bond-toggle-flash` A; `config-apply-now` idle and live; `input-picker` SOURCE_LOST; both `on-device-display` cases; `pairing` expiry (9) | The same cases fail on the clean base with `#js-failed` intercepting clicks. Pre-existing local setup failures, not R3 regressions. All pass in the final production run. |
| `encoder-capabilities` bitrate clamp; `field-lock` drop/fake success (2) | Historical traces show the same `#js-failed` interception. These specific cases pass on the clean base, while other cases reproduce that failure class. Intermittent setup failures; no exact-case baseline reproduction claimed. Both pass in the final run. |
| First six `sharing-surface` cases (6) | Historical run times out during the mount/auth helper, before scenario assertions. All six pass on the clean base and in the final run. The historical timeout is not individually reproduced; it is not a proven product regression. |
| Two truthfulness Configure expectations (2) | Pass on the clean base and fail after R3 intentionally enables router diagnostics without writable settings. Expectations corrected, with the claim-ladder checks above preserved and expanded. Both pass in the final run. |

The baseline additionally failed other bond-toggle, encoder-preview, field-lock,
relay and locale-smoke cases. This variation is why a blanket claim that the
exact same 19 tests were already broken would be false.

Two unsuccessful setup experiments are excluded from the comparison: stashing
the locale changes initially left generated registry imports referring to removed
message modules (fixed by running the existing `generate:i18n` command), and an
initial production-preview invocation omitted `VITE_DEVICE_HOST`/port, so no
WebSocket proxy was installed. That invocation hit its outer timeout and is not
a valid application regression result. The complete final run above used the
correct topology and completed normally.

## Gate results

| Gate | Result |
|---|---|
| `bun run lint`, including every package typecheck | Passed; existing Biome 29 warnings / 3 infos |
| Frontend `svelte-check` | 0 errors / 0 warnings |
| RPC tests | 507 passed |
| i18n tests | 709 passed |
| Frontend unit suite | 379 files / 6,274 passed, exit 0; final run reported 11 worker-shutdown timeout warnings |
| Hardware-preflight self-tests | 4 passed; no board contacted |
| Complete backend suite | 465 files / 6,052 passed / 2 existing skips / 0 failed |
| `BUILD_ARCH=amd64 bun run build` | Passed, binary and production SPA |
| `bun run check:tech-debt` | Passed |
| Functional Playwright, desktop and mobile | 426 passed / 278 existing conditional skips / 0 failures, no retries |

Editor diagnostics also exposed incomplete test-only socket/admin/FCC fixtures
and unresolved test-file path aliases; these were corrected without changing
production behavior or assertions. The affected unit suites were rerun after
those typing corrections. No producer-owned wire type was redeclared.
The earlier full unit run had no worker-shutdown warnings; the final rerun
reported them on unrelated files without failed tests or a nonzero exit. This
is retained as runner-health noise, not described as a warning-free gate.

Raw command logs are retained locally under the ignored `test-results/`:
`r3-base-e2e.log`, `r3-focused-e2e.log`, `r3-lint.log`, `r3-unit.log`,
`r3-build.log`, `r3-tech-debt.log`, and `r3-e2e-production.log`.

No board deployment, real portal authentication, or settings-write drill is
claimed. ZTE/UFI operator-login protocols remain unsupported by the login port;
captured targets with injected outcomes prove persistence ordering, not hardware
authentication. The next hardware drill remains separately authorized and gated.
