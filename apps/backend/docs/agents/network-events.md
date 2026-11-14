# Network timeline events [EXISTS]

The network producers call the typed device event emitter at existing decisions.
They add no probes, timers, thresholds or hysteresis.

- `uplink-health/runtime.ts` compares interface state at its single publication
  point. First observations emit nothing. Only a change between `up`, `degraded`
  and `down` emits `link_up`, `link_degraded` or `link_down`. Probe counters,
  observation timestamps, reasons and names changing alone do not emit events.
  Each publication replaces the comparison snapshot, so a pruned interface is
  new when it returns. Params carry the model's interface, kind and optional
  display name and reason; the optional duration is omitted.
- `state/netif-state.ts` emits `interface_added` and `interface_removed` from
  the existing reconciliation diff, independently of its replaceable callback.
  Every snapshot retains kinds from the existing uplink identity resolver,
  including publications whose address/counter data is unchanged. Removal uses
  the previous snapshot's kind because the USB scanner can retire descriptors
  before publishing the netif removal. The current snapshot replaces that
  history before callbacks run; absent interface identities are released.
  Pure reconciliation itself emits nothing.
- `lifecycle-indicators.ts` uses the existing `all-links-down` transition result
  for `bond_all_links_down` and `bond_links_recovered`, carrying the configured
  link count. Stream stop clears silently.
- `gateways.ts` records the existing offline claim and proven-connectivity
  retractions as `internet_lost` and `internet_restored`. Repeated verdicts
  emit nothing. A healthy initial observation emits nothing. Excluded-default
  claims remain withheld; successful candidate and natural-route recovery
  retract the offline state even if a later route application fails.

No event params include IP addresses, SSIDs or MAC addresses. The emitter owns
redaction, storage, journal output, delivery and coalescing; rapid edges sharing
a subject still follow its thirty-second window.

`src/tests/events-network-emits.test.ts` and
`src/tests/events-network-internet.test.ts` drive the real runtime, model, emitter
and file-backed store with injected clocks and existing I/O seams. Device
latency, CPU cost and journal volume on physical hardware remain unmeasured.
The presence-history, publication-edges and connectivity-reentry test files
record emitter calls before coalescing, distinguish each publication, and cover
classifier retirement, batched transitions/removals and callback reentry.
