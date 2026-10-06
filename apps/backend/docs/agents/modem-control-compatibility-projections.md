<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## MODEM-CONTROL COMPATIBILITY PROJECTIONS [EXISTS]

Todo 29 moved the frozen Todo-17 pure-logic set behind the published
`@ceralive/modem-control` package without raising CeraUI's install floor above
`0.2.0`. **The pin is now `1.3.0` EXACTLY**, and the three probes that
floor forced — the SMS port, the usage-policy setter, the band catalog — are
STATIC imports with no runtime fallback left.

`modules/modem-control-compat.ts` REMAINS, and that is deliberate rather than an
unfinished cutover. It is already a static namespace import, so it is not a lazy
`import()`; and two of its names — `hilinkConnectionBody` and `vidPidOf` — are
exported by NO release, which `modem-control-skew-matrix.test.ts` pins and the
installed 1.3.0 confirms. Their local implementations are PERMANENT, so deleting
the seam would delete the implementation. Each of the 14 MIGRATE modules asks for
its package function through it and keeps its own as the answer when the package
has none. Public CeraUI exports, wire fields, parser outcomes, and refusal
strings are unchanged.

The 14 modules are exactly the frozen ledger entries: five under `modems`
(`usb-mode-identity`, `sim-presence`, `five-g-preference`, `physical-identity`,
`modem-identity`), two under `cellular` (`dbus-mm-enums`,
`shadow-divergence`), and seven under `network` (`router-details`,
`hilink-documents`, `router-capabilities`, `usb-net-classifier`,
`router-signal-model`, `router-signal`, `vendor-xml`). No transport, session,
cache, RPC, wire, or router-admin proxy ownership moved with them.

Package operations receive CeraUI's existing stream-coupled policy through
`modules/modems/mutation-admission-port.ts`. It implements the package's
structural `MutationAdmissionPort` over `tryAcquireModemMutation`; a stream-active
request is refused as `admission-refused` with detail `streaming_active`, and an
admitted package lease releases the existing CeraUI lifecycle lease. The policy
therefore remains consumer-owned rather than moving into modem-stack.

`tests/modem-control-projections.test.ts` is the committed boundary gate. It
asserts all 14 modules use the named seam, every projection imports against the
exact `1.3.0` pin (asserted as a bare version, never a range — a resolved release
missing the statically-imported exports must fail at import rather than degrade),
direct `dbus|mmcli|qmicli|goform|hilink` references
remain inside the Todo-17 ledger allowlist, and stream-active admission preserves
the refusal vocabulary. Never add a direct modem transport/model/dialect path
outside that allowlist; add package consumption through a named projection
instead. Never replace the registry pin with `link:` or `file:`.

`@ceralive/modem-control@1.3.0` also exports the frozen
`MODEM_OPERATION_IDS` array from the existing root entry point. The frontend
parity gate resolves the backend's exact installed package, reads that registry
from emitted JavaScript without importing the D-Bus runtime graph, and holds the
local disposition manifest to set equality. The gate is unskipped: a missing
registry, an undispositioned package id, or a stale local id fails the suite.
The seven public package entry points are unchanged. `hilinkConnectionBody` and
`vidPidOf` remain absent from the package and permanently local behind
`modem-control-compat.ts`.

The same release activates the fifteenth compatibility consumer:
`modems/usb-mode-runtime.ts` resolves
`resolveRuntimeCompositionCapability` from the package. The module retains its
local implementation as the fallback and executable parity oracle;
`tests/usb-mode-runtime-compat.test.ts` proves the runtime candidate is selected,
assignable in both directions, and returns the same shapes for all four vendors
plus unsupported and malformed responses. This is deliberately read-only.
Although 1.3.0 also exports `buildRuntimeCompositionSetCommand` and
`RUNTIME_COMPOSITION_SET_REGISTRY`, CeraUI consumes neither; adding package-backed
composition writes is a separate feature requiring its own safety review.

