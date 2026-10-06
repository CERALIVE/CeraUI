<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## START-FAILURE DIAGNOSTICS [EXISTS]

The typed `StartFailure` contract preserves the optional original diagnostic
`message` alongside its stable `class` and `code`. `classifyStartFailure()` keeps
cerastream JSON-RPC messages (including invalid-params `-32602` and internal
`-32603` responses) generic and engine-authored; retry/terminal diagnostics and
notification params carry the field so it reaches `logger.error("stream start
failed", diagnostic)` and, through it, `getLog()` / the LogsDialog download. Do
not replace this with an engine-code-specific or HDMI-specific mapping — the
message is the generic diagnostic surface.

**It reaches the LOG, never the primary toast.** The frontend used to concatenate
`message` onto the localized failure toast; that shipped a raw JSON-RPC/ALSA
string (`invalid params: audio-device-unavailable: ALSA capture device
'hw:CARD=rockchiphdmiin' is busy or unavailable`) verbatim to an operator with no
console, stacked under a second toast telling them to run `journalctl`. Neither is
actionable for the audience CeraLive targets. `LiveView.startFailureMessage()`
therefore renders class + retry-state only, and every operator-facing string
points at Settings → System Logs instead of a shell command or a unit name. The
propagation above is UNCHANGED — do not weaken it to "fix" the toast, and do not
re-add the concatenation. Gate: `apps/frontend/src/tests/operator-copy-no-internals.test.ts`
sweeps all 10 locales for `journalctl` / `systemctl` / `*.service` / `hw:CARD=`.

### …AND A CAPTURE REFUSAL CARRIES ITS OWN CAUSE [EXISTS]

`START_FAILURE_CLASSES` gained exactly ONE member, `capture_source_unavailable`,
and `StartFailure` gained ONE additive optional field, `captureCause`. The engine
publishes the cause as typed data on its JSON-RPC error
(`error.data.capture_causes`, read through the bindings'
`CerastreamRpcError.captureCauses()` and mirrored from their `captureCauseSchema`;
the exact bindings pin lives in `apps/backend/package.json` and
`cerastream-bindings-skew.test.ts` holds the `SCHEMA_VERSION` it must declare).
Before the typed data existed, a capture refusal arrived as a bare `-32602` and
was classified `start_invalid`, which is honest about the code and says nothing
an operator can act on.

The taxonomy table (`START_FAILURE_CAPTURE_CAUSES` in `@ceraui/rpc`, a closed
enum that keeps the bindings' relative order):

| `captureCause` | What the engine refused on | Retriable at `start-rpc` | Rendered by |
|---|---|---|---|
| `negotiation_failed` | the capture leg could not negotiate the source's signal format | **no** | the failure toast |
| `no_signal` | the device is present and carrying nothing | **no** | the failure toast |
| `device_busy` | the node is held by another opener | **yes** | the failure toast |
| `composition-unsupported` | the board cannot combine two video inputs (its `rgacompositor` trial failed) | **no** | the toast, plus an inline refusal on the Composition card |
| `secondary-unavailable` | the second input of a picture-in-picture layout is not there | **no** | the toast, plus an inline refusal on the Composition card |

The two composition rows keep the producer's HYPHENATED spelling on purpose.
The classifier compares the engine's string to the enum verbatim, so "tidying"
either one to snake_case would make it unrecognised, and an unrecognised cause
degrades to the legacy path (rule three below). Only the first two arrived with
the class; the composition pair rode in with the two-leg composition work and
sits under the same class because it is the same refusal, one leg further along.

**CeraUI's enum is a deliberate SUBSET of the engine's.** The bindings'
`captureCauseSchema` publishes eleven causes; this build judges five. The other
six (`no_silicon_converter`, `decoder-unavailable`,
`software-pixel-path-rejected`, `unsupported-format`, `interlaced-unsupported`,
`source-changed`) are ones this build cannot yet turn into a retry verdict and
operator copy, so they are dropped to the legacy classification by design, not
by omission, and the skew test pins the producer's full list so a new engine
cause is a visible diff rather than a silent one. Adding a cause here means
adding all three of its halves at once: the enum row, its retriability row, and
its copy in every catalog.

Six rules are load-bearing:

- **The cause had to be FIRST-CLASS because retriability is keyed `(class, phase)`,
  and no existing class is retriable at `start-rpc`.**
  `START_FAILURE_RETRIABILITY` is a per-class table of `retriablePhases`, every
  entry of which is connect-phase-only or empty — so a single row for this class
  could only be all-retriable or all-non-retriable at the one phase a capture cause
  can be reported from. `isRetriableStartFailure(cls, phase, captureCause?)` takes
  a third OPTIONAL parameter and consults a cause-keyed override table
  (`START_FAILURE_CAPTURE_CAUSE_RETRIABILITY`). Every existing caller is unchanged,
  and the branch is scoped to this one class — do not make a second class
  cause-aware without a reason of the same shape.
- **Retrying `device_busy` is the only retry that can succeed.** The other four
  describe the signal on the cable, the camera at the far end of it, or a board
  capability that a retry budget cannot change; re-running the same launch against
  the same unchanged input spends the retry budget to be told the same thing three
  more times. `device_busy` is a contended opener (a libuvc rebind, the idle meter
  releasing a card), which is exactly the transient the bounded retry exists for.
  A `capture_source_unavailable` carrying NO cause is non-retriable, because
  nothing has said the condition is transient.
- **An ABSENT or UNRECOGNISED cause degrades to the legacy path, byte-identically.**
  `captureCauses()` answers `[]` for missing or unparseable error `data`, so an
  older engine falls straight through to the numeric-code table. An unrecognised
  cause STRING is dropped rather than minting the class without a discriminator: an
  unjudgeable cause cannot decide retriability, and degrading keeps a future engine
  enum from breaking the build. The classifier reads the FIRST reported cause
  (`captureCauses()[0]`): the engine lists one entry per refused device, in its
  own order, and the first is the one the operator's toast can act on.
- **There is no free-prose parsing anywhere on this path.** The cause is read from
  the typed `data` field only; the engine's `message` keeps its existing role (log
  only, never the toast) exactly as the section above states.
- **The copy is per CAUSE, and the class-level key is deliberately NOT a leaf.**
  `TERMINAL_NOTIFICATION_KEYS` is a TOTAL `Record<StartFailureClass, string>`, so
  the class carries a class-level notification key as its honest floor for a future
  engine that reports the class alone; `terminalNotificationKey` layers the
  per-cause selection (`CAPTURE_TERMINAL_NOTIFICATION_KEYS`, one key per cause in
  `stream-start-retry-reporting.ts`) over it. On the render side
  `live.startFailure.class.capture_source_unavailable` has one `.<cause>` child per
  enum member and NO string of its own — the frontend test helper re-nests the flat
  dotted catalog, so a key that is both a string and an object collides. The
  cause-less fallback is `live.startFailed.generic`, unreachable because the mapper
  never mints the class without a cause. Copy ships in all 10 locales and names the
  signal format plus the camera-side fix; the notification is non-persistent
  (`notificationBroadcast(..., 0, false, ...)`), so a `no_signal` refusal adds no
  second band beside the standing `hdmi_error`.
- **The frontend splits the causes by SURFACE, and the split is by cause, never by
  class.** `LiveView.startFailureMessage` keys the toast
  `live.startFailure.class.<class>.<captureCause>` for every cause. `LiveView`
  also hands `failure.captureCause` down to `IdleCockpit` → `CompositionCard`,
  which renders an inline refusal ONLY for the two composition causes: that card
  owns the second leg, so a composition refusal belongs beside the control that
  caused it. Every other cause belongs to the source card, which owns the primary
  leg, and gets the toast alone. Frontend half:
  `apps/frontend/AGENTS.md` → "Start watchdog + attempt generations + typed
  failure rendering".

Coverage: `apps/backend/src/tests/start-failure-taxonomy.test.ts` (the
three-cause capture matrix, the cause-aware retry table, the empty-list and
unrecognised-cause legacy fallbacks), `apps/backend/src/tests/cerastream-bindings-skew.test.ts`
(the published enum order, `captureCauses()` presence and empty-on-absence, and
`SCHEMA_VERSION`), and `apps/frontend/src/tests/live-start-failed-reason.test.ts`
(per-cause toast rendering plus the operator-copy sweep). The two composition
causes are pinned by the skew test and the catalog parity gate; they have no row
of their own in the taxonomy matrix and no rendered-DOM test on the Composition
card yet, which is a known coverage gap rather than a claim.

None of the above is board evidence. The class, the causes and the per-cause
retry rule are proven against the bindings' typed error and the frontend's
rendered DOM; the full board drill with released artifacts is a separate,
hardware-gated step and has not run.
