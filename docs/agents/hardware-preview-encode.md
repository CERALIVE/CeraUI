<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## HARDWARE PREVIEW ENCODE [EXISTS]

RK3588's platform HAL descriptor publishes a preview-hardware-encoder option
(`mpph264enc`), and CeraUI now exposes it as an operator-facing toggle. Three
independent facts travel this contract, none of which may be normalized into
one another (four distinct readings — see `cerastream/AGENTS.md`'s "four
readings" rule for the full statement):

1. **Capability** (idle-safe, platform fact) — `preview_hw_capability` inside
   the `capabilities` broadcast's `preview` block. `undefined` (legacy engine)
   and `false` (board publishes no preview encoder) both hide the toggle, but
   are not the same fact.
2. **Requested** — CeraUI's own persisted config, `previewEncode?: "software"
   | "hardware"` (camelCase; NOT an engine fact). Rides `streaming.setConfig` /
   `getConfig`. Applies to the NEXT stream session — the preview encoder is
   fixed at graph-build time, so it can never apply-now to a live session.
3. **Realized** (session-scoped) — `status.preview_encoder_realized`: `{
   selected_element?, realized_element, mode: "software"|"hardware",
   fallback_reason? }`. `mode` is the ACTIVE mode; there is no `requested`
   field here on purpose.

`apps/frontend/src/main/live/PreviewEncodeControl.svelte`, mounted inside the
collapsed Preview `<details>` (`PreviewDisclosure.svelte`), renders the toggle
only when capability is `=== true`. It shows the persisted request above a
divider and the realized state below it (`preview-encode-active` with
`data-mode`), plus an honest fallback row (`preview-encode-fallback`) keyed on
`fallback_reason.code` (`factory-missing` | `property-failure`, the latter
naming the refused property verbatim). A start-choke-point FENCE
(`streamloop/start-stream.ts`, the sole `start()` dispatch site) replays the
persisted `previewEncode` mode to the engine before every stream start —
stateless, not a dirty flag, so an engine restarted mid-idle by systemd still
gets re-told the operator's preference on the next start.

**None of this has been validated against a real hardware-preview session on
board yet.** See leg (iii) of
[`docs/DEVICE-STATS-VALIDATION.md`](../DEVICE-STATS-VALIDATION.md) for the
outstanding hardware-active / concurrent-utilization / CPU-drop legs, and leg
(iv) for the fallback-path legs. No leg has passed — this doc records what the
code does, not what a board has confirmed.

