<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## RPC PATTERN

Update actions retain the RPC envelope's optional `retryable` and distinct
`UPDATE_ORCHESTRATOR_INITIALIZING` code before `osCommand` consumes a rejection.
The existing Updates refusal band resolves that code to translated initialising/
retry-shortly copy in all ten catalogs; unknown codes and transport failures stay
generic. This changes neither persisted recovery data nor OS-stage reasons.

`LiveSourceSwitch` uses `active_encode.switch_targets` when present, including
synthetic legs; two distinct roster members form a switchable pair. Empty is authoritative,
absent retains the old two-capture gate. Each has its own localized notice, so unknown
does not read as explicitly unsupported. Discovery's virtual rows remain excluded.
Synthetic labels use the translated Test Pattern name plus the session's opaque id;
neither availability nor a display label is read from the producer target.
`deriveLiveSourceState` recognizes active session targets without fabricating a source.
See [LIVE-SESSION-SWITCHING](../../../../docs/LIVE-SESSION-SWITCHING.md) for U6/release limits.

### Uplink-health state [EXISTS]

`subscriptions.svelte.ts` is the sole consumer of the backend's `uplinks` push.
`getUplinks()` exposes the replace-whole `UplinksMessage`; `resetState()` clears it.
Do not add a second socket consumer or infer health from modem signal/netif fields.

### AN UPLINK ROW NAMES A DEVICE, ABOVE THE KERNEL NAME IT ANSWERS TO [EXISTS]

`SharingSection`'s uplink row leads with the device's own name and demotes the
interface name to a muted mono line beneath it, carried by the additive-optional
`UplinkRowView.displayName` (`sharing-section-view.ts`, threaded straight off
the wire record). Testids: `sharing-uplink-name-<iface>` /
`sharing-uplink-iface-<iface>`.

- **THE IFNAME IS NOT GARBLED, so it is demoted rather than replaced.**
  `wwu1u4u4i4` is the real predictable kernel name of the Quectel RM530N-GL's
  QMI netdev (`ww` + USB path `u1u4u4` + interface `i4`), and it is what every
  diagnostic on the device — `mmcli`, `ip`, the modem row's own `ifname` — will
  name back at an operator. Hiding it would trade one unreadable row for an
  unjoinable one.
- **ABSENT RENDERS EXACTLY AS BEFORE.** No name ⇒ the single mono `iface` line
  this row has always had, in the same size and weight. A device the backend
  could not name is the honest common case (a PCIe modem, a plain wired port, a
  backend that predates the field), so absence must cost nothing — a placeholder
  or a raw-id stand-in would be the fabrication the wire contract forbids.
- **The kind label is UNCHANGED and still stated.** The name says which device;
  the kind says what class it is. A named row keeps both.
- **The row is still keyed on `iface`.** Two units of one SKU legitimately
  render the same name, and only the interface tells them apart.

Coverage: `SharingSection.test.ts` → "an uplink is a DEVICE, keyed on its
interface" (the name/mono split, the byte-identical bare fallback, the twin-SKU
keying rule, and the kind still on screen). Device half:
`apps/backend/AGENTS.md` → …AND AN UPLINK'S KIND COMES FROM THE DEVICE.

### Sharing-coexistence verdict [EXISTS]

`getSharingDiag()` exposes the backend's read-only `sharing_diag` push — the
tri-state verdict on whether NetworkManager's shared-mode NAT floor and CeraUI's
own per-uplink NAT still coexist. Four rules:

- **It is REPLACED wholesale, never merged.** Every check is an EXPLICIT
  `ok | degraded | unknown`, so a field-preserving merge would re-create exactly
  the raise-but-never-lower latch those explicit values exist to prevent.
- **`undefined` means no snapshot has arrived**, which is distinct from a
  delivered payload whose checks read `unknown`. Never render absence as a clean
  bill.
- **`degraded` is never a failure.** Nothing on this signal gates a stream, an
  interface or a control — it is an honest amber verdict about a coexistence
  contract, and the reasons are wire-stable tokens that must be resolved to keyed
  copy at a render site, never printed raw.
- **A `firewall_backend_unpinned` reading is EXPECTED on a pre-pin image**, not a
  finding: the `firewall-backend=nftables` pin ships image-side.

The rendered Internet-Sharing surface that consumes it is a separate change; the
store slot, the ingestion case and its tests are all this one ships.

```ts
import { rpc, rpcClient } from '$lib/rpc';
await rpc.streaming.start(config);          // typed via TypedRPC in client.ts
await rpc.streaming.setConfig(fields);      // persist config without starting stream (Task 19)
rpcClient.onMessage((type, data) => { });   // raw push events
```

New procedures: add to `@ceraui/rpc` schemas first, then extend `TypedRPC` in `client.ts`.

