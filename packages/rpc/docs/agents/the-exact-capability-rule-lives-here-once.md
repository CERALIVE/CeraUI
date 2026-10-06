<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## THE EXACT-CAPABILITY RULE LIVES HERE, ONCE

### Producer-owned platform, source, and encoder capability shapes [EXISTS]

`intersect-caps.ts` imports `PlatformCaps` and `VideoSourceCap` from the published
`@ceralive/cerastream` package. `streaming.schema.ts` imports
`platformCapsSchema`, `videoSourceCapSchema`, `encoderCapsSchema`, and
`encoderCapabilitySchema` from its browser-safe `dist/messages.js` module and
re-exports the resulting `EncoderCapability` type. `capabilitiesMessageSchema`
adds only CeraUI-owned freshness/compatibility fields around those producer
schemas. Never replace these imports with a local interface or `z.object()`;
`producer-wire-type-shadow.test.ts` is the blocking gate.

`capabilities/device-mode-truth.ts` is cerastream ADR-0008 §10 in code: a device's
per-`media_type` mode ladder is the ONLY truth, and a consumer "may filter and it
may display, but it may not construct a mode the engine did not report, and it may
not merge two media types' ladders into one list."

That clause names TWO consumers, which is why the rule lives in this package rather
than in either of them:

- the frontend `ValidationAdapter` decides what the operator is OFFERED;
- the backend `streaming.setConfig` decides what may be PERSISTED.

They must agree BY CONSTRUCTION. An offering the save path would reject is a lie
told to the operator; a save the offering would have disabled is a bypass of the
rule. Two implementations of one rule drift — the frontend #244 defect (unioned
ladders offering a pairing the device could not deliver, failing `not-negotiated`
at the leg) was exactly that class, one layer up. Do NOT fork a per-consumer copy.

`evaluateDeviceMode` answers the SAVE-TIME verdict; `nearestDeliverableMode` answers
the LOAD-TIME clamp target. Both fail OPEN on an unknown — an absent ladder, an
un-normalizable rung, or a kind naming no advertised format never subtracts,
because refusing on an unknown blocks a save the hardware can honour.

