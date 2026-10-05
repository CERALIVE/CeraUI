<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## A REGISTRY PIN IS A VERSION BOUNDARY, AND THE GATE IS THE DELIVERABLE [EXISTS]

CeraUI consumes THREE npm producers whose wire data is Zod-validated:
`@ceralive/cerastream`, `@ceralive/control-protocol`, `@ceralive/modem-control`.
A pin is a version boundary as well as a path boundary, and the failure mode on
the wrong side of it is SILENT.

A fourth producer schema — the sender's telemetry — is still Zod-validated and
still in the drift manifest, but it is no longer PINNED: `@ceraui/srtla-send` is
a workspace package, so its schema and its consumer move in the same commit and
the version boundary does not exist for it.

**Zod's `z.object()` STRIPS unrecognized keys on `.parse()`.** So a consumer
pinned to an OLD binding whose schema does not know a NEW producer field drops
that field before any business logic sees it — no error, no warning, and a
PASSING typecheck whenever the consumer declared its own local shape for the
same wire data. Runtime-only, silent data loss.

The motivating case is recorded in full in the workspace root
[`AGENTS.md`](https://github.com/CERALIVE/CeraUI/blob/main/AGENTS.md) → BINDING-SCHEMA DRIFT: cerastream PR #126 added
`device_address` to `captureDeviceSchema`, and CeraUI PR #303 merged the same day
shipping BT-mic code reading `node.device_address` while still pinned to
`@ceralive/cerastream@2026.8.0`, whose gitHead predates PR #126 entirely.
`bluetooth-audio.ts`, `sources.ts` and `audio-naming.ts` each declared a LOCAL
`device_address?: string`, so TypeScript never saw the mismatch and the field was
Zod-stripped on every real device.

**`apps/backend/src/tests/producer-schema-drift.test.ts` is the enforcement.** It
holds ONE manifest of the producer wire-field paths CeraUI actually reads and
asserts, against the schemas ACTUALLY INSTALLED in `node_modules`, that every one
of them resolves. A stale pin plus new-field usage fails CI instead of a device.
Six properties are load-bearing:

- **It names NO producer version, and it must not.** The gate has to pass against
  ANY pin that carries the manifest's fields, so an additive bump stays green with
  no edit and a bump that RETIRES a consumed field fails loudly. Version and
  export-surface skew are a DIFFERENT axis, already guarded by
  `cerastream-bindings-skew.test.ts`, `srtla-send-bindings-skew.test.ts`,
  `modem-control-skew-matrix.test.ts` and
  `remote-control/protocol.export-surface.test.ts` — those pin the NAMES, this one
  pins the INSIDE of the schemas they name.
- **The manifest is a real inventory, not a wish list.** Every entry was
  established by finding the read site in `apps/backend/src`. Adding a field with
  no consumer is not harmless: it turns an unused producer field into a merge
  blocker for a producer that legitimately retires it.
- **It covers READS, not EMITS.** A field CeraUI only writes through a producer
  type (`SrtlaSendOptions`, the `device.hello` `deviceCaps` block) is an ordinary
  typed argument, so `tsc` already fails on a rename. The silent-strip hazard is
  specific to INBOUND data crossing a `.parse()`.
- **Schemas are duck-typed on `safeParse`, never `instanceof z.ZodType`.** Each
  producer bundles its own zod, so a cross-instance `instanceof` is not a reliable
  guard for a consumer copy — the same reason the bindings-skew tests give.
- **The resolver is proven able to FAIL.** A broken unwrapper that answered `true`
  for everything would leave the whole gate silently green, which is the exact
  defect class it exists to catch, so a non-vacuity test pins both directions.
- **It additionally asserts lockfile purity** — `bun.lock` carries no `link:`
  specifier and every producer dep is a bare registry version. The gate only means
  something while the installed producer really IS the pinned release.

**PUBLISH BEFORE CONSUME.** A producer PR that adds or changes a field in an
npm-published Zod schema must have its bindings PUBLISHED (tag pushed) BEFORE any
CeraUI PR referencing that field may merge. Do not let a producer's wire-schema
change and its npm publish drift apart across several merged PRs — cerastream PRs
#123–#126 all merged before any publish happened, which is exactly how the gap
above opened.

**`bun link` is the SANCTIONED DEV-TIME way to verify against an unreleased
producer, and a committed link is a defect.** The workflow, its rationale, and the
pre-commit check are in [`docs/CONVENTIONS.md`](../CONVENTIONS.md) → "Producer
schema drift — publish before consume". The one-line rule: the lockfile must stay
registry-resolved, `grep -c 'link:' bun.lock` must be `0`, and a `link:` in a
producer dep is a Rule-D path reference wearing a registry dep's clothes.

**NEVER redeclare a local type for producer-owned wire data.** Import the shape
from the published package's own exported types. A shadow type is what turns a
stale pin plus new-field usage into a silent runtime strip instead of a
compile-time error — it is what made the PR #303 case invisible to `tsc`, and it
is what this gate exists because the type system alone could not catch.

