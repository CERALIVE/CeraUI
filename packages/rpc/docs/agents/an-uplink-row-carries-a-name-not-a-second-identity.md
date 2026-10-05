<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AN UPLINK ROW CARRIES A NAME, NOT A SECOND IDENTITY [EXISTS]

`uplinkHealthRecordSchema.displayName` is additive-optional DISPLAY metadata —
the device's own operator-facing name (`Huawei E3372`, `Quectel RM530N-GL`, an
hwdb/vendor label), resolved by the device from the SAME USB-descriptor markers
the `netif` projection stamps.

Three shape decisions carry weight:

- **`iface` remains the row's identity, and nothing may key or join on the
  name.** Two units of one SKU legitimately publish the SAME name — the bench
  HiLink twins do — so a name-keyed consumer collapses two links into one. That
  is `conn_id`'s lesson (`status.schema.ts`) restated for a different field.
- **Absent is the honest common case, so it must cost nothing.** A PCIe modem, a
  plain wired port and a backend that predates the field all carry no name, and
  the consumer then renders the raw `iface` byte-identically to before. A
  placeholder or an id-shaped stand-in would be the fabrication the rest of this
  wire refuses everywhere else.
- **`.min(1)` is what keeps `""` from becoming a third state.** An empty name is
  neither a name nor an absence, and a consumer would render it as a blank line
  where a device should be.

Device contract: [`apps/backend/AGENTS.md`](../../../../apps/backend/AGENTS.md) →
…AND AN UPLINK'S KIND COMES FROM THE DEVICE, NOT FROM ITS NAME.

`uplinkShaperStatusSchema` is the sibling persistent state. Available states name
the lifecycle mode and realized algorithm (`cake` or `htb-fq_codel`). Unavailable
states carry one typed ownership/apply reason and the literal
`priorityDegraded: true`, making it impossible for a consumer to render an
unshaped shared uplink as protected. It does not alter steering availability.

