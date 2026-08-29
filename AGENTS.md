# CeraUI — Agent Knowledge Base

Parent: [`../AGENTS.md`](../AGENTS.md)

## ROLE IN THE GROUP

Device control plane. Svelte 5 PWA (frontend) + Bun/TypeScript WebSocket-RPC backend. Drives `cerastream` (active engine) and `srtla-send-rs` at runtime. Produces the `ceraui` .deb for ARM64 and AMD64 device images.

**Single engine.** `@ceralive/cerastream` is the ONLY streaming engine, consumed
as a public-npm registry dep. The legacy ceracoder engine and its sibling `link:`
dependency are fully retired (legacy `engine` values persisted in device
setup.json are coerced to `"cerastream"` at parse time with a warning).

The backend resolves both streaming deps as public-npm registry packages — no sibling checkout, no vendored tarball:

```
"@ceralive/cerastream":  "2026.8.1"   (public npm, @ceralive scope)
"@ceralive/srtla-send":  "2026.8.0"   (public npm, @ceralive scope)
```

Both are published npm packages (`@ceralive` scope on npmjs.org) consumed as normal registry deps, not `link:` paths and not vendored `.tgz` files. No sibling checkout of `srtla` or `srtla-send-rs` is needed for `CeraUI` to install or build.

## STRUCTURE

```
CeraUI/
├── apps/
│   ├── frontend/     # Svelte 5 PWA — Vite, TailwindCSS v4, shadcn-svelte, bits-ui v2, vitest
│   │   └── src/
│   │       ├── main/
│   │       │   ├── LiveView.svelte        # Live destination: stream control + config
│   │       │   ├── NetworkView.svelte     # Network destination: links, WiFi, modems, hotspot
│   │       │   ├── SettingsView.svelte    # Settings destination: grouped config entry points
│   │       │   ├── HudBar.svelte          # Persistent HUD bar (bitrate, links, SoC telemetry)
│   │       │   ├── HudRegion.svelte       # Responsive HUD mount (desktop top / mobile bottom)
│   │       │   ├── DisconnectedBanner.svelte  # Reconnect/reboot/failed banner
│   │       │   ├── dialogs/               # 14 focused config dialogs (AppDialog-based)
│   │   │   │   └── server/            # ServerDialog sub-components: DestinationSection, TransportRow, LatencySection, RelayServerSelector, CustomEndpointForm, ServerIngestSlots
│   │       │   └── tabs/                  # Legacy tab views (Streaming, Network, General, Advanced, DevTools)
│   │       └── lib/
│   │           ├── components/
│   │           │   ├── dialogs/           # AppDialog.svelte (shared chrome) + lazyDialog()/LazyDialog registry — config dialogs load as separate chunks on first open
│   │           │   ├── custom/            # Custom components (moved from ui/): simple-alert-dialog,
│   │           │   │                      #   mode-toggle, locale-selector, mobile-link, pwa/
│   │           │   ├── streaming/         # ValidationAdapter.ts — FE constraint adapter (no literals)
│   │           │   └── ui/                # shadcn-svelte primitives (bits-ui v2)
│   │           └── stores/
│   │               ├── hud.svelte.ts          # HUD state: pure derivation + lazy runes store
│   │               ├── connection-ux.svelte.ts # Reconnect/reboot/session-expiry UX state
│   │               └── layout-mode.svelte.ts  # Touch/kiosk layout flag ($persist)
│   └── backend/      # Bun server — WebSocket RPC via oRPC, serves frontend static
│       └── src/
│           ├── helpers/
│           │   ├── config-loader.ts       # loadJsonConfig + writeFileAtomicSync (E3)
│           │   └── config-schemas.ts      # runtimeConfigSchema — addons key lives here
│           ├── modules/system/
│           │           ├── device-stats.ts        # 5-signal device stats (S1 lock)
│           ├── encoder-load.ts        # per-core VEPU580 load; probes BOTH kernel realities
│           │   ├── device-detection.ts    # isRealDevice() — gates all add-on ops
│           │   ├── kiosk.ts               # Kiosk DC-2 state machine; toggle runs the cog-display add-on via the manager
│           │   ├── software-updates.ts    # apt/size parsing; APT_PACKAGE_NAME_RE
│           │   ├── software-update-service.ts # transient-unit lifecycle + retained exit status
│           │   └── software-update-process.ts # durable progress polling + restart reattachment
│           └── modules/addons/
│               └── manager.ts             # Add-on enable/disable state machine (T28)
├── packages/
│   ├── rpc/          # Shared oRPC schemas (workspace:*) — validation constants live here
│   │   └── src/schemas/
│   │       ├── addons.schema.ts           # AddonDescriptorSchema + AddonStateSchema (T21)
│   │       └── system.schema.ts           # KIOSK_UNAVAILABLE_ERROR + system schemas
│   └── i18n/         # Paraglide runtime + hand-editable JSON catalogs, 10 languages (workspace:*)
├── scripts/build/    # build-debian-package.sh — produces ceraui .deb
├── docs/             # ARCHITECTURE, BUILD_PIPELINE, APT_VERSION_CONTROL, BRANDING, TOUCHSCREEN, LIFECYCLE-INDICATORS
└── .impeccable.md    # UI/UX design constraints — read before touching frontend visuals
```

## WHERE TO LOOK

| Task | Location |
|------|----------|
| Live destination (stream control) | `apps/frontend/src/main/LiveView.svelte` |
| Network destination (links/WiFi/modems) | `apps/frontend/src/main/NetworkView.svelte` |
| Settings destination (config entry points) | `apps/frontend/src/main/SettingsView.svelte` |
| Persistent HUD bar | `apps/frontend/src/main/HudBar.svelte` + `apps/frontend/src/lib/stores/hud.svelte.ts` |
| Config dialogs (15 focused dialogs) | `apps/frontend/src/main/dialogs/` |
| **Device Health instrument (strip recorder, per-core encoder load)** | `apps/frontend/src/main/dialogs/DeviceHealthDialog.svelte` (shell) + `main/dialogs/device-health/DeviceHealthPanel.svelte` (instrument) + `lib/components/custom/health-trace-view.ts` (pure geometry) + `lib/stores/device-health-history.svelte.ts` (rings + playhead) |
| **Per-core encoder-load three-state model (percent / active / unavailable)** | `apps/frontend/src/lib/streaming/encoder-load.ts` + dev fixture `encoder-load-mock.ts` |
| **Per-core encoder-load COLLECTOR (two kernel realities, probed at runtime)** | `apps/backend/src/modules/system/encoder-load.ts` → `encoder-load` broadcast |
| **Fan presence + PWM duty-cycle COLLECTOR (`pwm-fan` found by type string, never an index; `pwm1/255` only, never RPM)** | `apps/backend/src/modules/system/fan.ts` → `fan` broadcast |
| **CPU core count (`nproc`-equivalent) — the denominator that makes `cpuLoad1` readable** | `apps/backend/src/modules/system/cpu.ts` → `cpu` broadcast; render side `apps/frontend/src/lib/system/cpu-load.ts` (`deriveCpuLoad`) |
| Shared dialog chrome (AppDialog) + lazy-dialog registry | `apps/frontend/src/lib/components/dialogs/AppDialog.svelte` + `lazyDialog()`/`LazyDialog`/`LazyDialogFallback` in the same directory |
| Reconnect/reboot/session-expiry UX | `apps/frontend/src/lib/stores/connection-ux.svelte.ts` |
| Touch/kiosk layout mode | `apps/frontend/src/lib/stores/layout-mode.svelte.ts` |
| Validation constraints (FE adapter) | `apps/frontend/src/lib/components/streaming/ValidationAdapter.ts` |
| **Apply-now vs apply-on-next-start choice (encoder dialog)** | `apps/frontend/src/main/dialogs/EncoderDialog.svelte` + `apps/frontend/src/lib/streaming/appliesNextStart.ts` (`restartChoiceRequired`) |
| **Config-change phase fencing + operator copy (frontend)** | `apps/frontend/src/lib/streaming/configChangePhase.ts` + `configChangeCopy.ts` |
| **One-shot, boot-scoped stream restoration after an engine death (armed marker, adopt-before-restore, explicit stop causes)** | `apps/backend/src/modules/streaming/armed-stream-marker.ts` + `stream-restoration.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → ONE-SHOT STREAM RESTORATION AFTER ENGINE DEATH |
| Validation constants (source of truth) | `packages/rpc/src/schemas/` |
| Custom UI components | `apps/frontend/src/lib/components/custom/` |
| shadcn-svelte primitives (bits-ui v2) | `apps/frontend/src/lib/components/ui/` |
| Backend RPC handlers | `apps/backend/src/` |
| Shared RPC contract | `packages/rpc/` |
| i18n strings | `packages/i18n/` |
| .deb build | `scripts/build/build-debian-package.sh` |
| Build system / CI | `docs/BUILD_PIPELINE.md` |
| Debian versioning | `docs/APT_VERSION_CONTROL.md` |
| System data flow | `docs/ARCHITECTURE.md` |
| **Repo conventions (incl. tech-debt register)** | `docs/CONVENTIONS.md` |
| **Technical-debt register (machine-checkable ledger)** | `docs/TECHNICAL_DEBT.md` + `scripts/check-tech-debt.mjs` |
| Touch/kiosk CSS spec | `docs/TOUCHSCREEN.md` |
| **Kiosk capability + inert-by-default model** | `docs/ON_DEVICE_DISPLAY.md` (cross-repo arch) |
| Kiosk state machine (DC-2) | `docs/KIOSK_STATE_MACHINE.md` |
| Kiosk token contract (DC-3) | `docs/KIOSK_TOKEN_CONTRACT.md` |
| Kiosk RPC + polling loop (backend) | `apps/backend/src/` (kiosk procedures, Task 23) |
| Kiosk settings dialog (frontend) | `apps/frontend/src/main/dialogs/` (Task 25) |
| Display-profile store + `?display=` param | `apps/frontend/src/lib/stores/display-profile.svelte.ts` |
| **Add-on Zod schemas (descriptor + state)** | `packages/rpc/src/schemas/addons.schema.ts` |
| **Add-on manager (enable/disable state machine, T28)** | `apps/backend/src/modules/addons/manager.ts` |
| **Device stats (5-signal broadcast)** | `apps/backend/src/modules/system/device-stats.ts` |
| **Config atomicity (E3)** | `apps/backend/src/helpers/config-loader.ts` — `writeFileAtomicSync` |
| **Config persistence placement map + storage-engine decision** | `docs/CONFIG_PERSISTENCE.md` |
| **Runtime config schema (addons key)** | `apps/backend/src/helpers/config-schemas.ts` — `runtimeConfigSchema` |
| **Logger (dev pretty + prod JSON + redaction + boot banner)** | `apps/backend/src/helpers/logger.ts` + `helpers/boot-banner.ts` |
| **Per-RPC call tracing** | `apps/backend/src/rpc/rpc-logging.ts` |
| **Mock subsystem (state, reset, schemas, fixture factory)** | `apps/backend/src/mocks/` — `mock-service.ts`, `mock-schemas.ts`, `fixture-factory.ts` |
| **Device-detection override helper (tests)** | `apps/backend/src/modules/system/device-detection.ts` — `withDeviceType()` |
| **Ingest sparkline memoization** | `apps/frontend/src/lib/components/custom/ingest-link-view.ts` |
| **Ingest visual/UX + @visual spec** | `apps/frontend/src/lib/components/custom/IngestStats.svelte` + `tests/e2e/visual/ingest-states.visual.spec.ts` |
| **Device/component versions (kernel + live cerastream engine read)** | `apps/backend/src/modules/system/revisions.ts` (`refreshEngineRevision`, `ENGINE_UNREACHABLE_REVISION`) |
| **CeraUI's OWN version row (packaged CalVer stamp \u2192 `dpkg-query` \u2192 git SHA; commit demoted, never dropped)** | `apps/backend/src/modules/system/revisions.ts` (`resolveCeraUiRevision`, `composeCeraUiRevision`, `CeraUiRevisionSources`) + the `/opt/ceralive/version` stamp in `scripts/build/build-debian-package.sh`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) \u2192 \u2026AND A BUILD-TIME VERSION IS NOT A COMMIT |
| **Versions row presentation (version promoted, build metadata demoted)** | `apps/frontend/src/lib/system/version-display.ts` (`splitVersionValue`) → `apps/frontend/src/main/dialogs/VersionsDialog.svelte` |
| Design rules | `.impeccable.md` |
| **The modem EVENT SOURCE beneath the wire producer** — observer adoption, the authority state machine, the MM-restart settle guard, the two SEPARATED failure classes, the shipped default cutover + rollback, and the startup cancellation contract | `docs/DBUS-OBSERVATION-CONTRACT.md`; code `apps/backend/src/modules/cellular/{dbus-modem-cache,dbus-view-fold,dbus-mm-enums,dbus-backend}.ts` |
| **Receiver-kind model + Scope-B plain-SRT contract** | `docs/RECEIVER_MODEL.md` |
| **ServerDialog protocol-first container** | `apps/frontend/src/main/dialogs/ServerDialog.svelte` |
| **ServerDialog sub-components (DestinationSection, TransportRow, LatencySection, RelayServerSelector, CustomEndpointForm, ServerIngestSlots)** | `apps/frontend/src/main/dialogs/server/` |
| **Receiver-experience pure logic (deriveDestination, resolveReceiverKind, buildServerSetConfig)** | `apps/frontend/src/lib/streaming/receiver-experience.ts` |
| **relay.validate procedure + mock seam** | `apps/backend/src/rpc/procedures/relay.procedure.ts` + `apps/backend/src/mocks/providers/relay.ts` |
| **Live server readiness hint (SRTLA bonded/single)** | `apps/frontend/src/main/live/ServerReadiness.svelte` |
| **Live header server chip (destination + kind)** | `apps/frontend/src/main/live/LiveHeader.svelte` |
| **Network-ingest gateway status (probes rtmp/srt systemd units, LAN URLs)** | `apps/backend/src/modules/network/network-ingest.ts` |
| **Gateway-active probe seam (blocks rtmp/srt stream start until the gateway is up)** | `apps/backend/src/modules/streaming/gateway-availability.ts` |
| **Network Ingest card (LAN RTMP/SRT publish sources, frontend)** | `apps/frontend/src/lib/components/custom/NetworkIngestSection.svelte` |
| **Gateway-availability truthfulness rule (single shared helper, no duplication)** | `apps/frontend/src/lib/streaming/pipelineAvailability.ts` |
| **Same-subnet / policy-route netif schema fields (`same_subnet_group`, `policy_route_missing`)** | `packages/rpc/src/schemas/network.schema.ts` (`netifEntrySchema`) |
| **Measured per-interface throughput (`tx_bps`/`rx_bps`, bits/s — `tp` is a byte delta, NOT a rate)** | `apps/backend/src/modules/network/network-interfaces.ts` (`computeInterfaceRate`) + `packages/rpc/src/schemas/network.schema.ts` |
| **Consolidated bond bandwidth (per-link + `TOTAL BANDWIDTH` ↑/↓)** | `apps/frontend/src/lib/helpers/bond-bandwidth.ts` (`aggregateBondBandwidth`) → `apps/frontend/src/main/network/BondedLinksSection.svelte` |
| **WiFi AP-vs-client classification (`isApMode` backend / `isApRadio` frontend)** | `apps/backend/src/modules/wifi/wifi-hotspot-types.ts` + `apps/frontend/src/lib/helpers/wifi-mode-outcome.ts` |
| **WiFi adapter identity (permanent hardware address — NOT the scan-randomized operational one)** | `apps/backend/src/modules/wifi/wifi-permanent-mac.ts` (`resolveWifiPermanentMac`) |
| **The ONE per-adapter WiFi lock key every mutation acquires (RPC layer AND hotspot transactions)** | `apps/backend/src/modules/wifi/wifi-adapter-lock.ts` (`wifiAdapterLockKey`, `wifiAdapterLockKeyForDeviceId`, `wifiAdapterLockKeyForConnectionUuid`, `withWifiAdapterLock`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → EVERY WIFI MUTATION SHARES ONE ADAPTER LOCK |
| **Regulatory country + kernel-DERIVED hotspot channels (`iw reg set` / `iw phy`; never a country→channel table)** | `apps/backend/src/modules/wifi/regdomain.ts` + `wifi-country.ts`; UI `apps/frontend/src/main/dialogs/WifiCountryDialog.svelte` + `lib/helpers/countries.ts` |
| **Per-adapter Wi-Fi CAPABILITY MODEL (nl80211 truth: bands, generation, widths, SAE, regulatory; `ifname → wiphy` via `/sys/class/net/<if>/phy80211`)** | `apps/backend/src/modules/wifi/wifi-capabilities.ts` over `regdomain.ts`'s single `runIw` seam; wire `wifiInterfaceSchema.capabilities?`; render side `apps/frontend/src/main/network/wifi-capability-view.ts` → `WifiSection.svelte`; contract below → THE WI-FI OFFERING IS DERIVED FROM THE RADIO |
| **Whether an AP may INITIATE on a band (rule-level `PASSIVE-SCAN`/`NO-IR`, not the per-channel flag) — the gate BOTH channel producers ask** | `apps/backend/src/modules/wifi/wifi-regulatory-rules.ts` (`parseRegulatoryRuleLine`, `buildApInitiationGate`) consulted by `regdomain.ts` (`parseIwPhyChannels`, `deriveApInitiationBands`) AND by `wifi-interfaces.ts` (the `auto_*` rungs); `WifiHotspot.bandCapability` is the un-latched memory of the adapter's own band answer |
| **Capability-derived hotspot security offering + read-only negotiated width** | `apps/backend/src/modules/wifi/wifi-hotspot-security.ts` (read-time derivation, deliberately NOT a cached field); UI `apps/frontend/src/main/dialogs/hotspot-options.ts` → `HotspotDialog.svelte` |
| **Connected hotspot clients (`iw dev <if> station dump`; dBm tiers, NOT the 0-100 nmcli ramp)** | `apps/backend/src/modules/wifi/wifi-hotspot-clients.ts`; render side `apps/frontend/src/main/network/hotspot-clients-view.ts` → `HotspotSection.svelte` |
| **Detected-but-driverless wireless/BT adapters (PCI class + USB INTERFACE-node scan, parent-coalesced)** | `apps/backend/src/modules/network/` sysfs probe → additive `status.unclaimed_adapters[]`; band in `apps/frontend/src/main/network/NetworkView.svelte` |
| **BLUETOOTH foundation (BlueZ D-Bus, pairing agent, device registry, class model, service enablement, boot reconcile)** | `apps/backend/src/modules/bluetooth/` (`bluetooth-stack.ts`, `bluetooth-registry.ts`, `bluetooth-classes.ts`, `bluetooth-services.ts`, `bluez-agent.ts`, `bluez-agent-exporter.ts`, `bluetooth-runtime.ts`, `bluetooth-wire.ts`); RPC `apps/backend/src/rpc/procedures/bluetooth.procedure.ts` + `packages/rpc/src/{contracts,schemas}/bluetooth.*`; render side `apps/frontend/src/main/network/bluetooth-view.ts` → `BluetoothSection.svelte`; contract below → THE BLUETOOTH FOUNDATION |
| **BT MICROPHONE as an audio source (`org.bluealsa` PCM presence is the oracle, NOT BlueZ `Connected`)** | `apps/backend/src/modules/bluetooth/` (PCM probe) + `apps/backend/src/modules/streaming/audio.ts`; loss/reconnect `apps/backend/src/modules/streaming/bluetooth-audio-resilience.ts`; render side `apps/frontend/src/lib/streaming/bluetooth-audio-source.ts` → `SourceSection.svelte`; contract below → THE BT MICROPHONE IS A SOURCE, NOT A SPECIAL CASE |
| **Durable per-adapter hotspot identity (SSID/password reused forever) + duplicate-profile consolidation** | `apps/backend/src/modules/wifi/hotspot-credentials.ts` + `wifi-hotspot-discovery.ts` (`findHotspotConnForAdapter`, `pruneDuplicateHotspotConns`) |
| **Capability-gated AP+STA concurrency (`iw phy` proof → virtual `__ap` interface → independent UI controls)** | `apps/backend/src/modules/wifi/wifi-ap-sta-capability.ts` + `wifi-concurrent-interface.ts`; frontend `apps/frontend/src/main/network/WifiSection.svelte`; contract [`docs/AP-STA-CONCURRENT-MODE.md`](docs/AP-STA-CONCURRENT-MODE.md) |
| **Policy-route self-check for bonded wifi/modem/dongle interfaces** | `apps/backend/src/modules/network/policy-route-check.ts` |
| **Flow-sticky hotspot/shared-LAN steering + per-uplink NAT** | `apps/backend/src/modules/network/uplink-steering/` + `modules/network/uplink-sharing.ts`; contract [`docs/UPLINK_STEERING.md`](docs/UPLINK_STEERING.md) |
| **Streaming-first egress priority + adaptive client cap** | `apps/backend/src/modules/network/uplink-shaper/`; contract [`docs/UPLINK_SHAPING.md`](docs/UPLINK_SHAPING.md) |
| **Whether the two shared-client NAT layers still coexist (READ-ONLY, tri-state `sharing_diag`)** | `apps/backend/src/modules/network/sharing-diag/`; wire `packages/rpc/src/schemas/network.schema.ts` → `sharingDiagSchema`; frontend `apps/frontend/src/lib/rpc/subscriptions.svelte.ts` (`getSharingDiag()`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND THE TWO NAT LAYERS ARE WATCHED, NEVER ARBITRATED |
| **Router-dongle netns metadata reader — PRODUCER RETIRED (phase-C todo 39), reader KEPT as the old-image degradation path** + the retractable `dongle` netif marker (wire-only union rows; bonding untouched by construction) | `apps/backend/src/modules/network/dongle-metadata.ts` + `network-interfaces.ts` (`applyDongleProjection`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → AN ISOLATED DONGLE IS SURFACED WITHOUT ENTERING THE BOND |
| **Rendering a ModemManager reading that may be ABSENT without losing WHY (rsrp/rsrq/snr/sinr + measurement recency, operator/cell registration, SIM presence evidence)** | `apps/frontend/src/lib/modem/signal-detail.ts` (pure; the ModemManager twin of `main/network/router-signal.ts`) → `apps/frontend/src/main/dialogs/ModemConfigDialog.svelte`; wire `packages/rpc/src/schemas/modems.schema.ts` (`modemSignalDetailSchema` / `modemRegistrationContextSchema` / `modemSimPresenceEvidenceSchema`); contract in [`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md) → …AND AN ABSENT MEASUREMENT STATES ITS OWN REASON |
| **Whether a modem-config save must re-establish the bearer (shared rule; the dialog's pre-save notice and the device's tear-down read the SAME one)** | `packages/rpc/src/schemas/modem-apply-scope.ts` (`normalizeModemConnectionFields`, `diffModemConnectionFields`, `decideModemReactivation`) → `apps/backend/src/modules/modems/modems.ts` (`applyModemConfig`, `ModemApplyDeps`) + `apps/frontend/src/main/dialogs/ModemConfigDialog.svelte` (`modem-reconnect-notice`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → A MODEM SAVE SPENDS A RECONNECT ONLY WHEN IT MUST |
| **Every NM gsm profile bound to a modem's SIM carries the operator's answer (roaming enforcement + evidence-gated duplicate deletion)** | `apps/backend/src/modules/modems/gsm-duplicate-reconcile.ts` (`reconcileDuplicateGsmProfiles`, `classifyGsmDuplicate`, `auditGsmProfiles`) → `modems.ts` (`enforceAcrossProfiles`) + `modem-registration.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND EVERY PROFILE BOUND TO THE SIM CARRIES THE SAME ANSWER |
| **Capability feature-gate framework + the FIVE-STATE support-claim taxonomy (band-lock / SMS / 5G-pref / FCC-auto-unlock / GPS / USSD / eSIM)** | ladder `packages/rpc/src/schemas/capability-modules.schema.ts` + `packages/rpc/src/capabilities/capability-matrix.ts`; device gates `apps/backend/src/helpers/config-schemas.ts` (`modem_capabilities`, default-absent) + `apps/backend/src/modules/modems/capability-gates.ts`; the SHARED mutation-enforcement helper `apps/backend/src/modules/modems/capability-mutation.ts` (wraps todo-25's lease); wire block `modem.capability_modules`; render side `apps/frontend/src/main/network/capability-modules.ts`; engine side `modem-stack/control/src/capability/`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → THE CAPABILITY FEATURE-GATE FRAMEWORK |
| **…and the operator's WRITE for those gates (`modems.getCapabilities`/`setCapabilities` + the Settings dialog the band-lock/GPS copy points at)** | wire `packages/rpc/src/schemas/capability-modules.schema.ts` (`modemCapabilitiesOutputSchema`, `setModemCapabilityInputSchema`); device `apps/backend/src/rpc/procedures/modems.procedure.ts` (`get`/`setModemCapabilitiesProcedure`); the change-gated re-publication seam `apps/backend/src/modules/modems/capability-gates.ts` (`noteCapabilityEvidenceChanged`) installed by `capability-evidence.ts`; UI `apps/frontend/src/main/dialogs/ModemCapabilitiesDialog.svelte` via `SettingsView` → System; contract below → THE GATES HAVE AN OPERATOR SURFACE |
| **modem-control compatibility projections (exact 1.3.0 pin; package-owned operation registry actively gates UI parity)** | `apps/backend/src/modules/modem-control-compat.ts` + the 14 frozen pure projection modules + the fifteenth read-only runtime-composition resolver in `modules/modems/usb-mode-runtime.ts`; package mutation admission bridge `modules/modems/mutation-admission-port.ts`; boundary/floor gate `apps/backend/src/tests/modem-control-projections.test.ts`; runtime resolver gate `apps/backend/src/tests/usb-mode-runtime-compat.test.ts`; operation drift gate `apps/frontend/src/tests/modem-parity-drift.test.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → MODEM-CONTROL COMPATIBILITY PROJECTIONS |
| **Whether a modem holds a SIM (`no_sim`) — read from MM's slot, NEVER from the presence of an NM connection profile** | `apps/backend/src/modules/modems/sim-presence.ts` (`deriveSimPresence`, `claimsNoSim`, `isSimObjectPath`) → `modem-status.ts` + `modem-wire-projection.ts`; D-Bus twin `apps/backend/src/modules/cellular/dbus-view-fold.ts` (`readSimPresence`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → `no_sim` REPORTS A SLOT, NOT A NETWORKMANAGER PROFILE |
| **Generation-fenced modem network scans (dispatch admission → targeted/full lifecycle broadcasts → bounded unknown outcome)** | backend `apps/backend/src/modules/modems/modem-network-scan.ts`; wire `packages/rpc/src/schemas/modems.schema.ts`; frontend `apps/frontend/src/lib/rpc/subscriptions.svelte.ts` + `main/dialogs/ModemConfigDialog.svelte` |
| **Read-only SMS inbox routed by `modem_backend` (`dbus` package port + retained `mmcli` rollback)** | `apps/backend/src/modules/modems/{sms-backend,dbus-sms,mmcli-sms}.ts`; D-Bus ports rebuild by MM epoch and fold `Added`/`Deleted`, while mmcli remains the explicit rollback reader; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → THE READ-ONLY SMS INBOX |
| **Operator-settable data-usage policy (cycle day + advisory limit) — a LOCAL write, because ModemManager exposes no data-usage API** | `apps/backend/src/modules/modems/usage-policy.ts` (static import of `@ceralive/modem-control`'s `setUsagePolicy`, versioned 0600 store) + `modems.configure`'s tri-state `data_usage_cycle_day` / `data_usage_threshold_bytes`; wire block `modem.data_usage_policy`; render side `apps/frontend/src/main/dialogs/ModemConfigDialog.svelte` + the pure `main/dialogs/modem-usage-policy.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → THE DATA-USAGE POLICY IS A LOCAL WRITE |
| **Router-mode cellular dongles RENDERED AS MODEMS (classifier → `modems` roster; claim-based section handover)** | `apps/backend/src/modules/modems/modem-wire-producer.ts` (`collectRouterCellularSources`) + `modem-wire-adapters.ts` (`fromRouterCellularView` — NOT interchangeable with `fromRouterView`); render side `apps/frontend/src/main/network/CellularSection.svelte` + the pure `main/network/section-assignment.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND IT IS LISTED AS A MODEM, WITH THE ONLY SURFACE IT REALLY HAS |
| **A router dongle's own ADMIN WEB UI, reverse-proxied through CeraUI's origin and BOUND to that unit's interface (identical twins share one address)** | `apps/backend/src/modules/network/router-admin-proxy.ts` (pure: path, argv, header parse, URL rewriting) + `apps/backend/src/modules/ui/dongle-admin-proxy.ts` (target resolution + `curl --interface`) + `apps/backend/src/modules/ui/dongle-admin-session.ts` (single-use token → scoped HttpOnly cookie); route forked in `apps/backend/src/rpc/server.ts`; RPC `modems.openRouterAdmin`; render side `apps/frontend/src/main/network/router-admin-open.ts` + `CellularSection.svelte` + `RouterDongleDialog.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND ITS OWN WEB UI IS REACHED THROUGH A DEVICE-BOUND REVERSE PROXY |
| **A router dongle's own HTTP admin API (HiLink XML / ZTE goform / UFI himiapi; read-only by evidence; `curl --interface` is load-bearing)** | `apps/backend/src/modules/network/router-cellular-admin.ts` → the additive `modem.router_admin` wire block (`packages/rpc/src/schemas/modems.schema.ts`) |
| **Whether that admin API needs a LOGIN — the five-state lock model (`open` DETECTED, never assumed), the credential store's consumption, and the capability expansion an unlock produces** | `apps/backend/src/modules/modems/modem-lock-state.ts` (pure model + session + `gateRouterAdminByLock`) + `modem-credential-verify.ts` (one attempt, never a retry) + `modem-credentials.ts` (todo 7's 0600 store); RPC `modems.setCredentials` / `clearCredentials` / `verifyCredentials` (`apps/backend/src/rpc/procedures/modems-credentials.procedure.ts`, `authedProcedure`); wire `modem.lock_state` + `modem.lock_detail`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND WHETHER IT NEEDS A LOGIN IS ONE OF FIVE STATES |
| **The ZTE/UFI non-signal detail block (ONE batched `multi_data` read; absent field ⇒ no row; write-fenced)** | `apps/backend/src/modules/network/router-details.ts` → `router_admin.details`; render side `apps/frontend/src/main/dialogs/router-dongle-fields.ts` + `RouterDongleDialog.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND THE ZTE/UFI READS EXPANDED WITHOUT GAINING A WRITE |
| **HiLink network-mode CAPABILITY discovery (read-only; a `112008` refusal is a reading, never a control)** | `apps/backend/src/modules/network/router-capabilities.ts` → `router_admin.capabilities`; render side `apps/frontend/src/main/dialogs/router-dongle-fields.ts` (`netModeCapability`) + `RouterDongleDialog.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND THE HiLINK CAPABILITY IS DISCOVERED BEFORE ANYTHING IS OFFERED |
| **The router-dongle WRITES it gates (net-mode + the OPTIONAL, journaled LAN-subnet hygiene rewrite) — Stage B** | `apps/backend/src/modules/network/router-cellular-control.ts` + `router-subnet-{plan,hygiene,rollback}.ts` over `hilink-{session,documents}.ts`; RPC `apps/backend/src/rpc/procedures/modems-router.procedure.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND THE WRITES IT GATES ARE STAGE B |
| **Canonical physical-device identity + the `link_id` authority (serial ≻ ID_PATH ≻ ifname; feeds bonding AND naming)** | `apps/backend/src/modules/modems/physical-identity.ts` (pure resolver + `mintLinkId` + display-name precedence) + `physical-identity-source.ts` (binds it to the live caches) + `apps/backend/src/modules/network/router-cellular-scan.ts` (`UsbPhysicalDescriptor`, `getUsbPhysicalDescriptor`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND ONE RESOLVER DECIDES WHICH PHYSICAL DEVICE IT IS |
| **ADR-003 bind-map WRITER (twin modems both bond) + the duplicate-IP policy split + the pre-spawn capability probe + the typed-disposition producer boundary** | `apps/backend/src/modules/streaming/bind-map.ts` (pure document/rows/collision groups) + `bind-map-writer.ts` (atomic two-file publication) + `bind-map-spawn.ts` (`--bind-map` only on a valid probe) + `srtla-capabilities.ts` (`--capabilities-json`, bounded) + `bind-map-disposition.ts` (ONE normalized stream, todo 8's exact value names) + `bind-map-notification.ts` (operator band) + `srtla.ts` (`genSrtlaBondEntries`, `publishSrtlaBond`) + `modules/network/network-interfaces.ts` (`isBondCandidate`, `setBondOptOut`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND THAT IDENTITY IS PUBLISHED AS A BIND-MAP |
| **Router-mode cellular dongle classification (USB descriptors, NEVER the interface name; independent of the netns layer)** | `apps/backend/src/modules/network/usb-net-classifier.ts` (pure, Rule-D mirror of modem-stack) + `router-cellular-scan.ts` (sysfs read + cache); render side `apps/frontend/src/main/network/EthernetSection.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND IT IS NAMED CELLULAR WITHOUT WAITING FOR THAT LAYER |
| **Dongle vendor/model resolution (udev-hwdb model for a device that publishes a class string; immune to the duplicate-MAC `ID_RENAMING` collision)** | `apps/backend/src/modules/network/usb-net-classifier.ts` (`publishesGenericIdentity`, `vendorLabel`, `modelLabel`) + `router-cellular-scan.ts` (`readUdevDatabaseNames`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND A DONGLE THAT NAMES A CLASS IS GIVEN ITS REAL MODEL |
| **Dongle vendor/model HONEST FLOOR (a class string is never re-printed as a name) + the twin discriminator** | `apps/backend/src/modules/network/usb-net-classifier.ts` (`vendorLabel`, `modelLabel`, `unitDiscriminator`) + `router-cellular-scan.ts` + `modem-wire-adapters.ts` (`routerCellularDisplayName`); contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND A DONGLE THAT NAMES A CLASS IS GIVEN ITS REAL MODEL |
| **An MM-managed modem's own data function (`usb_modem_net`) — the FM350's RNDIS interface is not a second device** | `apps/backend/src/modules/network/router-cellular-scan.ts` (`scanUsbNetMarkers`, `getModemNetMarker`) + `network-interfaces.ts` (`applyModemNetProjection`); render side `apps/frontend/src/main/network/section-assignment.ts` + `EthernetSection.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND AN MM-MANAGED MODEM'S DATA FUNCTION IS NOT A SECOND DEVICE |
| **Interface address is reported, not set (no backend apply path exists; the retired static-IP field also discarded bond changes)** | `apps/backend/src/modules/network/network-interfaces.ts` (`handleNetif`) + `apps/frontend/src/main/dialogs/NetifDialog.svelte`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → THE INTERFACE ADDRESS IS REPORTED, NOT SET |
| **Isolated-dongle ROW (identity + lifecycle badges, disabled-with-reason bond toggle)** | `apps/frontend/src/main/network/EthernetSection.svelte`; contract in [`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md) → Isolated-dongle row |
| **Subnet-collision + policy-route info/warning bands (frontend)** | `apps/frontend/src/main/network/CollisionBands.svelte` |
| **Connection/subscriptions store (sole `rpcClient.onMessage` owner — `websocket-store` fully deleted)** | `apps/frontend/src/lib/rpc/subscriptions.svelte.ts` |
| **Auth-state single-mutation-path store (`ingestAuth`/`authenticate`/`createPassword`)** | `apps/frontend/src/lib/stores/auth-status.svelte.ts` |
| **Capability-truthfulness regression e2e gate** | `apps/frontend/tests/e2e/truthfulness.spec.ts` |
| **Unified device-first `sources` builder + engine-device cache + `config.source` routing seam** | `apps/backend/src/modules/streaming/sources.ts` (`buildSources`, `getSourcesMessage`, `deriveEngineRouting`, `resolveSourceRouting`) |
| **StreamSetupChain (readiness + config rows + Start, one always-visible 3-row card — no collapse; mounted in `IdleCockpit`; `GoLiveCard.svelte` is now an unmounted migration shim, see `TD-unmounted-source-shims`)** | `apps/frontend/src/main/live/StreamSetupChain.svelte` |
| **Preview disclosure (the preview `<details>` + `PreviewCanvas`; mounted by BOTH cockpits so preview is reachable idle AND mid-stream)** | `apps/frontend/src/main/live/PreviewDisclosure.svelte` |
| **Preview `input_id` stable-identity resolution (the preview leg's `start` frame, unified with `streaming.start`'s routing)** | `apps/backend/src/modules/ui/preview-proxy.ts` (`resolvePreviewStartFrame`) |
| **Idle/Live cockpit split (LiveView switches on the optimistic streaming edge)** | `apps/frontend/src/main/live/IdleCockpit.svelte` + `apps/frontend/src/main/live/LiveCockpit.svelte` |
| **Pure Go-Live readiness derivation (source/network/destination/engine gates — consumed byte-unchanged by StreamSetupChain)** | `apps/frontend/src/lib/streaming/go-live-readiness.ts` (`deriveGoLiveReadiness`) |
| **Unified device-first source list (unified `<ul>`, single audio surface, selected-row-only network publish instructions, operator-disabled-row filtering)** | `apps/frontend/src/lib/components/custom/SourceSection.svelte` |
| **Destination traffic-light validation store (session-only, fingerprint-keyed `relay.validate` verdict)** | `apps/frontend/src/lib/streaming/destination-validation.svelte.ts` |
| **Network-ingest operator enable/disable (topology-aware desired-state + systemctl apply + boot reconcile)** | `apps/backend/src/modules/network/network-ingest-control.ts` |
| **Settings "Network ingest" dialog (per-protocol enable/disable toggle)** | `apps/frontend/src/main/dialogs/NetworkIngestDialog.svelte` |
| **BondedLinksSection — sole owner of live per-link telemetry (RTT/NAK/weight) on the Network view** | `apps/frontend/src/main/network/BondedLinksSection.svelte` |
| **Twin disambiguation — a telemetry row is a PHYSICAL device, not a file position (`link_id` registry, port label, `status.bond_mapping`)** | backend `apps/backend/src/modules/streaming/link-registry.ts` + `link-telemetry-rows.ts` + `link-mapping-report.ts`; frontend `apps/frontend/src/main/network/link-disambiguation.ts` + `bond-mapping-band.ts`; contract in [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → …AND A TELEMETRY ROW IS A PHYSICAL DEVICE |
| **Lifecycle indicator gap matrix + recommendations register (31-row inventory: EXISTS/FIXED/RECOMMENDED per transition)** | `docs/LIFECYCLE-INDICATORS.md` |
| **Deprecation-shim register entries (legacy broadcasts + unmounted GoLiveCard-migration files)** | `docs/TECHNICAL_DEBT.md` → `TD-legacy-source-broadcasts` / `TD-unmounted-source-shims` |
| **`device.activeProfile` status-frame emitter (drift-detection loop)** | `apps/backend/src/modules/remote-control/active-profile-reporter.ts` (`reportActiveProfile({force?})` — reads the ACTUALLY-applied `StreamConfig` via injected `readActiveProfile`, de-dups on the 4 fields, emits `{config}` via injected `broadcast`) + `active-profile-wiring.ts` (`wireActiveProfileReporter()` — binds `readActiveProfile` to the persisted `stream_profile`/`srt_latency`/`fec_enabled`/`recovery_mode` config, `broadcast` to `broadcastMsg`; called from `main.ts` after `wireSetProfile()`). Three emit sites: `set-profile-wiring.ts` (after a successful `setProfile` apply), `rpc/procedures/streaming.procedure.ts` (after a UI Stream-Tuning config change), `modules/remote-control/channel.ts` `handleOpen()` (force re-emit on control-channel connect/reconnect — reseeds the hub, which loses its snapshot on disconnect). Frame type registered in `protocol.ts` `STATUS_TYPES` + `RELAYABLE_TYPES` (`status-relay.ts`) as `ACTIVE_PROFILE_STATUS = "device.activeProfile"`. Platform-side consumer: `ceralive-platform/apps/api/lib/remote-control/hub/internal-gate.ts` `applyActiveProfile` (see `ceralive-platform/AGENTS.md` → SRT-receive profile reconciliation) |

## COMMANDS

```bash
bun install           # installs all workspaces; resolves registry deps (no sibling checkout required)
bun run dev           # frontend + backend via mprocs TUI (Vite 6173 + backend 3002)
bun run build         # compile backend binary + frontend static
bun run test:release-package-contracts   # provenance + release graph + dispatch-input security
BUILD_ARCH=arm64 ./scripts/build/build-debian-package.sh   # .deb for ARM64
BUILD_ARCH=amd64 ./scripts/build/build-debian-package.sh   # .deb for AMD64
bun run --filter backend check   # type-check backend (TS 7 via scripts/tsc.mjs) + exec guards
bun run --filter frontend test   # vitest frontend unit tests
bun run build:frontend && bun apps/frontend/scripts/check-precache.mjs   # PWA precache-manifest gate
```

## ADD-ON SUBSYSTEM [EXISTS]

The add-on subsystem lets CeraUI install, enable, and disable optional feature
sysexts at runtime without a reflash. It is gated on `isRealDevice()` — all
add-on operations are no-ops in dev/emulated mode.

**Zod schemas** (`packages/rpc/src/schemas/addons.schema.ts`) [EXISTS]

`AddonDescriptorSchema` mirrors the image-baked JSON descriptor format from
`image-building-pipeline/v2/manifests/schema/addon.schema.json`. It is the single
TypeScript source of truth for the descriptor shape — never duplicate it in `apps/`.

`AddonStateSchema` describes per-feature runtime state persisted under the `addons`
key of `config.json`. Fields: `enabled`, `phase`, `versionMaterialized`,
`osVersionMaterialized`, `userConfig`, `lastError`, `autoDisabled`.
`osVersionMaterialized` (T29) records the OS VERSION_ID the staged `.raw` was
fetched for, so the reconciler can detect an OTA-stale artifact by exact (G1)
match. The persisted `phase` enum (`ADDON_PHASES`) is
`idle | installing | active | pending | disabling | error`; `pending` (T29) is
the reconciler's non-terminal "wanted but not yet materialisable" state.

Key regex constants (defined once in `addons.schema.ts`, imported everywhere):
- `ADDON_ID_RE` — lowercase alphanumeric + hyphens (stricter than `APT_PACKAGE_NAME_RE`)
- `SEMVER_RE` — `MAJOR.MINOR.PATCH` with optional pre-release/build
- `SYSEXT_PATH_RE` — `/usr/…` or `/opt/…` only (G2 contract)
- `ARTIFACT_URL_RE` — HTTPS with mandatory `{os_version}` placeholder

**Config atomicity (E3)** [EXISTS]

All writes to `config.json` go through `writeFileAtomicSync` in
`apps/backend/src/helpers/config-loader.ts`. The pattern: write to a sibling temp
file (`.<name>.<pid>.tmp`), `fsync`, then `rename` — so a crash mid-write never
corrupts the live config. The `addons` key in `runtimeConfigSchema` defaults to
`{}` when absent, so old configs without the key parse cleanly.

Test coverage: `apps/backend/src/tests/addons-config-state.test.ts` — round-trip,
crash-mid-write, and missing-key defaulting.

**Manager state machine** (`apps/backend/src/modules/addons/manager.ts`) [EXISTS]

The runtime orchestration layer (T28). Mirrors the kiosk state machine: every
OS/network/persistence primitive is injected through `AddonManagerDeps` (DI for
tests), and the SAME crash-loop discriminator drives auto-disable.

- **Manager phases** (`AddonManagerPhase`): `disabled → enabling → enabled`,
  `enabled → disabling → disabled`, plus `failed`, `pending`, `auto_disabled`.
  `toAddonState`/`phaseFromState` losslessly map these onto the schema-valid
  `AddonState` triple (`enabled` + `phase` + `autoDisabled`), so `config.json`
  always parses even though the persisted `phase` enum is coarser.
- **Enable pipeline** (ordered, each gated/atomic): `isRealDevice()` (G6) →
  free-space precheck (E1: `/data` free > `sizeInstalled × 2 + 512 MiB`) →
  download → `/data/tmp/<id>.raw.tmp` → sha256 (+ helper GPG) verify → atomic
  rename → `/data/extensions/<id>.raw` → `ceralive-addon-helper enable <id>` →
  unmask + start descriptor units → validation probe (auto-disable on failure).
- **Disable pipeline**: reverse + idempotent — stop + mask units → helper
  `disable` → remove artifact → drop config state.
- **Crash-loop auto-disable**: `pollAddonCrashLoop` reads `NRestarts` per unit;
  `>= ADDON_CRASH_LOOP_RESTART_THRESHOLD` (3) masks the units and parks the
  add-on in `auto_disabled` (same rule as kiosk T5).
- All privileged work is delegated to `ceralive-addon-helper` (G-trust); the
  manager never mutates the sysext scan dir or systemd directly on the trusted
  path — it drives the helper and argv-only `systemctl`.

Test coverage: `apps/backend/src/tests/manager.test.ts` — pure mapping, the
enable/disable pipelines, crash-loop + validation auto-disable, and the G6/E1
negative paths.

**Post-boot reconciler** (`apps/backend/src/modules/addons/reconciler.ts`) [EXISTS]

`runAddonReconciler()` (T29) reconciles desired state (config.json `addons`)
against the materialised `/data/extensions/<id>.raw` sysexts after a boot/OTA. It
is **fire-and-forget and NEVER gates boot or the OS-update healthcheck/rollback** —
every failure is caught and downgraded to a persisted `pending` phase; the run
never throws and self-serialises (a concurrent call is a no-op).

- Per enabled add-on: if the staged `.raw` is missing **or** its
  `osVersionMaterialized` ≠ the live `/etc/os-release` VERSION_ID (G1 exact
  match — never loosened), re-fetch `artifact.urlTemplate` (substituting
  `{os_version}` + `{board}`) → sha256 + GPG verify → atomic stage → helper
  `refresh`.
- **No compatible artifact** (404 / network / descriptor `compatibleOsVersions`
  excludes the live OS): set `phase: pending` + `lastError:
  addon_not_available_for_os_version`. Boot is unaffected.
- **Live stream**: a disruptive refresh is deferred — set `phase: pending` +
  `lastError: addon_refresh_deferred_streaming`; retried on the next boot.
- Triggered from `main.ts` at startup (non-blocking) and re-pokable via SIGUSR1
  from the `ceralive-addon-reconciler.service` oneshot (deployment/), which is
  deliberately NOT wired into any rollback/healthcheck target.
- All effectful surface is injected via `ReconcilerDeps`; default deps are built
  lazily (dynamic import) so the module never pulls the streaming/config graph or
  requires `setup.json` at test-import time.

Test coverage: `apps/backend/src/tests/addon-reconciler.test.ts` — re-materialise
(missing + VERSION_ID mismatch), idempotency, the pending/defer negative paths,
and the boot-safety (never-throws) + emulated-mode no-op guarantees.

**Packaging contract (#194).** `ceralive-addon-reconciler.service` is staged into
the `.deb` **from `deployment/`**, not from `dist/`. `dist/` only ever held the
unit as a side effect of `build_backend_only` mirroring `deployment/*` into it, so
the unit's presence in the package was hostage to that mirror step. Sourcing it
directly from `deployment/` makes the staging explicit and mirror-independent.
Pinned by a contract test wired into `bun run test:release-package-contracts`,
which asserts the unit is staged, enabled in `postinst`, and present in the payload
of a scratch-built `.deb` — so a future build-script refactor cannot silently drop
the post-boot reconciler from the device image.

**sysext refresh protocol**

The add-on manager must follow the protocol from
`image-building-pipeline/v2/docs/addon-sysext-refresh.md`:
- **Update:** `systemd-sysext refresh` → `systemctl restart <addon>.service`
- **Disable:** `systemctl stop <addon>.service` → `systemd-sysext refresh`

Never report an add-on "updated" or "disabled" on the strength of the sysext call
alone. The service restart (on update) or stop (on disable) is what makes the
transition real.

**isRealDevice() gate**

All add-on operations (install, enable, disable, refresh) MUST call
`await isRealDevice()` at entry. In dev/emulated mode return
`{ success: false, error: "addon_unavailable_in_emulated_mode" }` without touching
`systemd-sysext` or `systemctl`. Read-only status queries are NOT gated. The
manager's `enableAddon`/`disableAddon`/`pollAddonCrashLoop` all enforce this gate
as their first step (`ADDON_UNAVAILABLE_ERROR`).

## DEVICE HEALTH PANEL [EXISTS]

A read-only Settings instrument (Settings → Device, beside Power and Versions)
showing SoC temperature and the 1-minute load average **over time**, plus the
encoder's condition. Its thermal/load lanes add **no RPC and no contract change**
— those signals were already on the wire — and the `device-stats` 5-signal
broadcast (S1 lock) is untouched. Per-core encoder load is the one signal that
needed a producer, and it got its OWN `encoder-load` broadcast rather than a
sixth `device-stats` field (see below).

Two rules carry it, both documented in full in
[`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md):

- **The trace's right edge is wall-clock `now`, never the last sample.** A feed
  that stops does not freeze — it falls behind the playhead and leaves a widening
  void, so staleness is geometry rather than a badge. Hand-rolled SVG + GSAP, no
  chart library.
- **Per-core encoder load has THREE states, and two of them are not numbers.**
  The vendor 6.1 and mainline edge-7.1 kernels report VEPU580 load
  incomparably — real percentages via `mpp_service` on one, only the cores' clock
  enable-state (busy/idle, no percentage anywhere) on the other — so a core is
  `percent` | `active` | `unavailable`, each with its own visual vocabulary.
  Rendering busy/idle as a percentage would fabricate a denominator the driver
  never produced.

**The per-core collector now EXISTS** (`apps/backend/src/modules/system/encoder-load.ts`,
`TD-encoder-load-telemetry` resolved 2026-08-05). Both reads are root-only — the
same privileged class as the `sensors.ts` thermal read, using the same plain
`Bun.file()` seam, since the backend runs as root — and which kernel interface is
live is **probed at runtime**, never inferred from `uname` or a board id, because
a device can be moved between the two kernels by swapping boot media. It publishes
its own `encoder-load` broadcast; the full contract is in
[`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → PER-CORE ENCODER LOAD.

The collector is `isRealDevice()`-gated, so a dev host publishes NOTHING for this
signal and the frontend's dev-only `?health-mock=` fixture stays the single
mocking mechanism for it. That absence IS the real-vs-mock seam — there is no
build-flag branch choosing between them, and a device reading always wins,
**including when what it read was "neither interface exists"**.

**Decoder rows ride the same `encoder-load` broadcast, additively.** On the
vendor 6.1 kernel (`mpp-service` interface only — never mainline/edge 7.1),
`decodeCores` carries one row per `*.rkvdec*` device, using the SAME
discriminated-union row shape as the encode `cores` array (`percent` |
`active` | `unavailable`). The key is OMITTED (never `[]`) when the kernel
publishes no decode load interface, and its length is board-derived rather
than a fixed two-slot list. `EncoderStatus.svelte`'s `showDecoders?: boolean`
(default `false`) opts a mount site into rendering the decoder section; only
Device Health passes `true` today. See leg (ii) of
[`docs/DEVICE-STATS-VALIDATION.md`](docs/DEVICE-STATS-VALIDATION.md) for the
outstanding real-decode-load validation.

## MOCK SUBSYSTEM [EXISTS]

The mock subsystem provides hardware simulation for development and testing. It is
activated by `MOCK_SCENARIO` env var and gated behind `shouldUseMocks()` — never
`isDevelopment()` directly. All mock state is owned by `mock-service.ts`.

**Zod-validated fixtures (`mocks/mock-schemas.ts`):**
Every shipped fixture in `mock-config.ts` is validated against a Zod schema at
`initMockService()` time. A drifted fixture (wrong IMEI length, bad IPv4, unknown
SIM-lock state) fails loudly in dev instead of silently feeding malformed data into
the mmcli/nmcli/relay providers. Schema types are the single source of truth — both
`mock-config.ts` and `mock-service.ts` re-export `z.infer<...>` types from here.

**`resetMockState()` for per-test isolation:**
`initMockService()` captures a deep `structuredClone` of the seeded state as a
pristine snapshot. `resetMockState()` restores that snapshot AND clears all timers
(periodic-fluctuation + relay) — side-effect-clean, so each test starts from the
scenario's seeded state with no leaked intervals or cross-test bleed. Use in
`afterEach` for any test that mutates mock state.

**`updateMockState(partial)` — single write path:**
All writes to `mockState` funnel through the typed `updateMockState(partial)` mutator
(Object.assign top-level merge). The four named setters (`setMockModemConfig`,
`setMockWifiConnection`, `setMockNetifConfig`, `setMockEncoderConfig`) are thin
wrappers that compute the next slice and delegate to it.

**Bluetooth mocks (`providers/bluetooth.ts`):**
Dev/e2e parity for the BlueZ path with no controller: an adapter, a discoverable
roster, a pair/trust state machine and a bounded, TIMED scan window, all in
memory. Three rules carry it:

- **Nothing states `deviceClass` / `scoCapable` / `transport`.** All three are
  DERIVED through the production code that derives them on a board
  (`deriveCapability()` + `buildBluetoothStatus()`), so a fixture claiming a SCO
  leg beside an A2DP-source-only UUID is unexpressible rather than merely
  discouraged. The roster spans all four outcomes on purpose: an HFP mic
  (`audio-input` + `scoCapable`, battery 80%), an A2DP-source-only phone
  (`audio-input`, NO SCO leg — the forcing case), a playback-only speaker and a
  bare advertisement (both `unknown`).
- **The state is OUTSIDE `mockState`, and that is deliberate.** It owns scan
  timers, which `structuredClone` cannot capture, so the pristine snapshot could
  neither hold nor restore them. Its seed is a pure function of the active
  scenario, so `resetMockBluetoothState()` — called by BOTH `initMockService()`
  and `resetMockState()` — re-derives the pristine state and drops every timer.
- **Refusals use the SHARED `bluetoothMutationRefusalSchema` vocabulary**, in the
  same gate order `bluetooth.procedure.ts` applies, so a dev refusal a surface
  renders is the string a board would answer with. `setMockBtScenario(partial)`
  is the test/dev override seam (the `setMockEngineCapabilities` pattern) that
  makes the adapter-absent and operator-disabled arms reachable without a
  scenario per combination.

**Add-on + kiosk mocks (`providers/addons.ts`, `providers/kiosk.ts`):**
`MockAddonDescriptor` and `MockAddonState` are the canonical fixtures for add-on
tests. `MOCK_KIOSK_STATUS`, `MOCK_KIOSK_TOKEN`, and `MOCK_COG_DISPLAY_DESCRIPTOR`
are the kiosk fixtures. `resetMockKioskState()` resets kiosk state between tests.

**SIM PIN mock (`mocks/mock-schemas.ts` + `fixture-factory.ts`):**
`MockSimState` carries `lock`, `pinRetries`, and `pukRetries`. The factory's
`buildMockSimState(overrides)` builds a schema-valid SIM state for tests that need
to exercise the PIN/PUK unlock flow without a real modem.

**Cerastream error simulation (`providers/streaming.ts`):**
The streaming mock provider can simulate structured engine errors (Tier-2 codes from
`cerastream-error-mapping.ts`) so the frontend notification path is testable without
a real cerastream process.

**Device-detection override (`modules/system/device-detection.ts`):**
`withDeviceType(type, fn)` is the canonical test helper for flipping the
`isRealDevice()` gate. Sets `CERALIVE_DEVICE_TYPE` before calling `fn`, restores
(or deletes) in a `finally` block — exception-safe and supports nesting.

**Fixture factory (`mocks/fixture-factory.ts`):**
One typed builder per mock domain object: `buildMockModem`, `buildMockWifiRadio`,
`buildMockWifiNetwork`, `buildMockRelay`, `buildMockAddonDescriptor`,
`buildMockAddonState`, `buildMockKioskToken`, `buildMockSimState`. Each builder
merges caller overrides with sensible defaults and runs the result through the same
Zod schema that validates the shipped fixtures — an out-of-range value throws at the
build site, not at the provider.

**Engine-driven health mock:**
The streaming mock provider exposes a `MockHealthState` slot that drives the
`ingest-health` signal in dev. Tests can set `health.score` and `health.degraded`
via `updateMockState` to exercise the health-alert rendering path.

**Scenario-seeded capability profiles (T5):**

Three scenario-seeded `MOCK_SCENARIO` values drive the engine-capability state that
`getCapabilities()` serves to the frontend. The mock fetcher drives the fallback
ladder by what it returns or throws — no direct flag mutation:

- `caps-full` — full engine profile: H265 + hardware accel, audio-capable HDMI
  source, `audio_live_switch` enabled, `transports: ["srtla","srt"]`. Use this to
  exercise the full Live destination UI (all controls enabled, RIST/SRT transport
  selector visible).
- `engine-starting` — mock fetcher throws `CerastreamConnectionError` with an empty
  cache, so `getCapabilities()` returns the minimal safe floor with
  `engineStarting: true`. Simulates the device booting before cerastream is ready.
- `engine-unavailable` — mock fetcher throws after seeding a last-known-good
  snapshot, so `getCapabilities()` returns the cached snapshot with
  `engineUnavailable: true`. Simulates a cerastream crash after a successful start.

**`setMockEngineCapabilities(partial)` — test-only capability override seam (T5):**
`setMockEngineCapabilities(partial)` (exported from `mocks/providers/streaming.ts`)
merges a `Partial<ScenarioCapabilities>` onto the active scenario's profile, then
immediately re-broadcasts the resolved `capabilities` event. Gated by
`shouldUseMocks()` — a no-op in production. Use in tests that need a specific
capability combination without switching the full scenario. Call only while the
stream is idle; the override is cleared by `resetMockState()`.

**Scenarios:**

| `MOCK_SCENARIO` | Description |
|-----------------|-------------|
| `multi-modem-wifi` | Default: 3 modems + WiFi (multi-modem-wifi) |
| `single-modem` | 1 modem, no WiFi |
| `streaming-active` | Active streaming simulation with live telemetry |
| `modem-pin-locked` | 2 modems, WiFi off, modem 0 SIM PIN-locked (fixture PIN `0000`) — drives the SIM unlock/PUK flow end-to-end in dev; the `unlockSim`/`unlockSimPuk` RPCs route to the mock SIM state machine |
| `bt-mic-paired` | Bluetooth on with an HFP mic already paired/trusted/connected (battery 80%) — the steady state a source surface renders. The default `multi-modem-wifi` is the OTHER half: BT on with an empty registry, so the scan → discover → pair flow is what a developer lands on |
| `caps-full` | Full engine caps: H265 + hw accel, audio-capable source, live audio switch, SRT transport (idle) |
| `engine-starting` | Engine still booting — minimal safe floor + `engineStarting` flag |
| `engine-unavailable` | Engine unreachable — cached/minimal snapshot + `engineUnavailable` flag |

## DEVICE STATS [EXISTS]

`apps/backend/src/modules/system/device-stats.ts` broadcasts the original **5
signals** on a `device-stats` event every 5 seconds (S1 lock), plus **four
additive-optional signals** shipped on top of that lock: `memory`, `cpuFreq`,
`ddr`, and `gpu`.

| Signal | Description |
|--------|-------------|
| `disk` | Used/total bytes on `/data` + media type (SSD/HDD/eMMC/unknown) |
| `cpuLoad1` | 1-minute load average |
| `socTemp` | SoC temperature (wired from `sensors.ts` — no second `/sys/class/thermal` read) |
| `ifaceRxTx` | Per-interface RX/TX byte counters |
| `raucSlot` | Active RAUC A/B slot |
| `memory` (optional) | Parsed `/proc/meminfo` fields (`memTotalBytes`, etc.) — a genuinely-read `0` is kept; an unreadable source omits the keys |
| `cpuFreq` (optional) | Array of `{id, curKhz, maxKhz}` per `/sys/devices/system/cpu/cpufreq/policy*` directory. `id` is the directory name verbatim — never relabeled "big"/"little" and never used to infer core counts. `maxKhz` is the hardware ceiling (`cpuinfo_max_freq`), not the governor-movable `scaling_max_freq`. Absent when nothing is measurable, never `[]` |
| `ddr` (optional) | `{loadPercent, curFreqHz, maxFreqHz}` from the DDR devfreq node. All-three-or-nothing. Probed under `/sys/class/devfreq`: a case-insensitive exact `dmc` match first, then any entry matching `/dmc/i` or `/dfi/i` (lexicographically sorted). Hz, not kHz — do not share a formatter with `cpuFreq` |
| `gpu` (optional) | `{loadPercent, curFreqHz?, maxFreqHz?}`. `loadPercent` required; frequencies independently optional, because the Mali kbase path (`/sys/class/misc/mali0/device/{utilisation,utilization,gpu_busy_percent}`, probed in that order) structurally cannot report a frequency. Falls through to devfreq GPU (`/\.gpu$/i` suffix match under the same `/sys/class/devfreq` directory) when kbase is absent. Hz, not kHz |

Adding a field to the always-present five is a deliberate contract change, not a
tweak. Every collector wraps its read in its own `try/catch` and degrades to
`null`/omission on failure — a missing `/sys` path or absent `rauc` binary must
never crash the sampling loop. The four newer signals are OMITTED (never
zero-filled or empty-array-filled) when their kernel interface does not exist —
absence on a given kernel is the expected, honest state, not a gap to paper over.
**None of the raw sysfs node paths/contents these four probes read have been
confirmed against a real board yet** — see
[`docs/DEVICE-STATS-VALIDATION.md`](docs/DEVICE-STATS-VALIDATION.md) leg (i) for
the outstanding capture step.

**A new device signal therefore gets its OWN broadcast**, exactly as `encoder-load`
did. The CPU core count is the third one, and it exists because `cpuLoad1` above is
UNREADABLE without it: a load average is a count of runnable tasks, so `1.00` on an
8-core RK3588 is about an eighth of the board while reading as saturation to anyone
who does not already know the core count (the operator report that produced it).
`apps/backend/src/modules/system/cpu.ts` publishes a `cpu` event carrying
`{ cores: number | null }` — a BOOT FACT resolved once and re-served from the
post-auth initial-state push, not a sample, since core count cannot change without
a reboot. It is deliberately NOT `isRealDevice()`-gated (every host has CPUs, so
gating it would leave dev and CI rendering the bare load average the fix replaced),
and `cores` is nullable so a host that cannot report its topology degrades to the
raw figure rather than having a denominator invented for it. Full contract:
[`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → CPU TOPOLOGY.

The fan is the second one: `apps/backend/src/modules/system/fan.ts` publishes
a `fan` event (5 s, `isRealDevice()`-gated) reporting fan PRESENCE plus a PWM duty
cycle derived from `pwm1 / 255` — never an RPM (the board's fan is 2-wire and has
no tachometer) and never `cur_state / max_state` (an index into a devicetree table,
not a fraction of airflow). The `pwm-fan` cooling device is discovered by its `type`
string, never by a `cooling_deviceN`/`hwmonN` index — both were measured shifting
across a reboot on the reference board. On the mainline/edge kernel that cooling
device carries NO `device` backlink at all, so the collector also correlates by
the `hwmon<N>/name == "pwmfan"` string; that fallback is gated on a confirmed
`pwm-fan` cdev and reports `unknown` rather than guessing when two hwmons match.
Full contract: [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → FAN.

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
[`docs/DEVICE-STATS-VALIDATION.md`](docs/DEVICE-STATS-VALIDATION.md) for the
outstanding hardware-active / concurrent-utilization / CPU-drop legs, and leg
(iv) for the fallback-path legs. No leg has passed — this doc records what the
code does, not what a board has confirmed.

## DEVICE DETECTION + KIOSK EMULATION SAFETY

`isRealDevice()` lives in `apps/backend/src/modules/system/device-detection.ts` and is re-exported from `apps/backend/src/modules/system/kiosk.ts`. It follows the same `deps`-injection pattern as the rest of the kiosk module (`DeviceDetectionDeps` + `defaultDeviceDetectionDeps`).

Detection contract (fail-safe, defaults to `false`):
1. `CERALIVE_DEVICE_TYPE==="real"` → true; `==="emulated"` → false (env override wins over everything)
2. `isDevelopment()` → false (short-circuits before any hardware probe)
3. `/proc/device-tree/compatible` OR `/proc/device-tree/model` contains the
   RK3588 marker (`"rk3588"`, matched case-insensitively) → true. `compatible`
   is the RELIABLE marker (always carries `rockchip,rk3588`, even on boards like
   the Radxa ROCK 5B+ whose `model` reads just `"Radxa ROCK 5B+"` with no
   `RK3588` substring); `model` is a belt-and-suspenders fallback for boards
   whose model string itself names the SoC (e.g. Orange Pi 5+). Generic
   Rockchip, RK3399, and RK356x identities fail closed
4. x86 mini-PC path: `/etc/ceralive/release` contains `ID=ceralive` AND DMI
   `/sys/class/dmi/id/{product_name,board_name}` contains a mini-PC marker
   (`N100`, `N200`, `Mini PC`, `MINIPC`) → true
5. Any probe throws (file absent/unreadable) → false for that probe (never propagates)
6. Unrecognised or malformed identity → false. Jetson is deliberately unhandled/deferred.

**Hardware-kind detection + `setup.json` drift guard (Todo 59 audit).**
`device-detection.ts` also exports `detectHardwareKindFromDeviceTree()` —
positively resolves the board family (`"rk3588" | "jetson" | "n100" | "unknown"`)
from the SAME reliable probes `isRealDevice()` uses, checking
`/proc/device-tree/compatible` FIRST (the marker that fixed the Todo 48 bug), then
`model`, then the x86 DMI product name. Markers are matched conservatively (the
specific SoC token, never a broad `"rockchip"`) so an unsupported RK3399/RK356x
resolves `"unknown"` instead of being mis-stamped `rk3588`.

`warnOnHardwareIdentityDrift()` is a boot-time, **warn-only** guard wired into
`main.ts` (`guardNonCritical("hardware-identity-drift", …)`, fail-soft): on a real
device it compares `setup.json` `hw` against the detected kind and logs a loud
`logger.warn` on a POSITIVE mismatch (`"unknown"` defers to config; dev/emulated
hosts are skipped). WHY: `setup.json` `hw` is a SINGLE hardcoded value packaged
verbatim into the `ceralive-device` .deb for every board/arch — there is no
per-board `setup.json`, and the image pipeline does NOT rewrite it (it leaves
`/etc/ceralive/conf.d/hardware.conf` on `auto`). So an AMD64/N100 or Orange-Pi
image still ships `hw:"rk3588"`. This guard stays as an independent boot-time
signal and is NOT superseded by the provider below (it fires even when the engine
is down, comparing setup.hw against the device-tree).

**Resolved hardware-kind provider — `setup.hw` demoted to fallback (Todo 15).**
`modules/system/hardware-kind.ts` is now the SINGLE runtime authority for "what
board am I on". The four consumers that previously read `setup.hw` directly
(`sensors.ts`, `audio.ts`, `pipelines.ts` → `getEffectiveHardware()`,
`addons/reconciler.ts` `getBoard`) all resolve through it. Resolution order,
highest-authority first, each tier failing through: (1) **engine** —
cerastream's `get-capabilities` `platform.hardware_kind` (cerastream Todo 14),
read via a NARROW RAW IPC PROBE (`probeEngineHardwareKind`) that dials the control
socket directly and reads the optional `platform` field tolerantly, because the
published `@ceralive/cerastream` client Zod-STRIPS the nested `platform.hardware_kind`
field (the binding is not republished); (2) **device-tree** —
`detectHardwareKindFromDeviceTree()` (`"unknown"` falls through); (3) **setup.hw** —
the static value (KEPT as fallback + test seam; NOT removed); (4) **generic** floor.
The resolved value is cached WITH its source tier (`getHardwareKindTier()`) and
RE-RESOLVED on every engine reconnect/capability refresh (`engine-reconnect.ts`
heal path re-runs `getHardwareKind()` before re-broadcasting pipelines/sources) —
so a boot-time device-tree/setup.hw fallback is superseded by the engine value once
cerastream comes up, and a re-resolution that CHANGES the kind logs a loud drift
warning. Reads: `getHardwareKind()` (async, full ladder + cache) and
`getHardwareKindCached()` (sync, hot paths; returns the `setup.hw` fallback before
the first resolve so a boot-time read is byte-identical to the pre-migration value —
RK3588 behavior is byte-unchanged, asserted in tests). Coverage:
`tests/hardware-kind.test.ts` (resolution-order table, drift warning, each consumer
under mocked kinds).

Real platform pairing parses `PLATFORM_URL` before any secret registration or
claim request. HTTPS is required on production and real devices; plaintext HTTP
is accepted only for `localhost`, `127.0.0.1`, or `[::1]` while the backend is in
development mode and device detection is emulated. Malformed, non-loopback HTTP,
and all other non-HTTPS URLs fail before a pairing secret, claim code, or issued
token can cross the boundary. Pairing POSTs also reject redirects so an accepted
HTTPS endpoint cannot replay a credential body through a downgrade redirect.

**`isDevelopment()` power-gate (T1):** `isDevelopment()` (defined in
`apps/backend/src/mocks/mock-config.ts`, `NODE_ENV==="development" ||
MOCK_MODE==="true"`) is the gate for all dev-only side-effects. The
`system.poweroff` and `system.reboot` RPC handlers skip the real OS spawn when
`isDevelopment()` is true — they return `{success:true}` without calling
`poweroff`/`reboot`. The post-update reboot in `software-updates.ts` is gated the
same way via `rebootAfterUpdate()`. DI runner seams (`setPowerCommandRunner`,
`setRebootRunner`) let tests assert the exact command without touching the host.
**Never use `isDevelopment()` to gate mock-hardware paths** — use `shouldUseMocks()`
for that (the mock subsystem requires both `isDevelopment()` AND
`mockState.initialized`).

**Dev reboot-disconnect helper (T2):** `simulateDevReboot()` (exported from
`apps/backend/src/rpc/events.ts`) reproduces the real-device reboot effect in dev:
it snapshots `getAuthenticatedClients()` and closes each socket after a macrotask
delay (`setTimeout(..., 0)`). The delay is critical — it lets the in-flight
`system.reboot` reply (`{success:true}`) flush to the client before the socket
drops, matching the real-device sequence where systemd takes the host down after
the reply is sent. The frontend's `DisconnectedBanner` then shows the "rebooting"
state and reconnects normally. Gated by `isDevelopment()` — the early return means
no production call site can schedule socket teardown through this helper.

**Kiosk RPC handlers are emulated-safe.** The 4 action handlers (`kioskStart`, `kioskStop`, `kioskConfigure`, `kioskOsk`) in `apps/backend/src/rpc/procedures/system.procedure.ts` gate on `await isRealDevice()` at entry. In dev/emulated mode they return `{ success: false, error: "kiosk_unavailable_in_emulated_mode" }` without invoking `systemctl`. `kioskStatus` is NOT gated (read-only config; the settings UI needs it to render).

The error constant `KIOSK_UNAVAILABLE_ERROR` is the single source of truth in `packages/rpc/src/schemas/system.schema.ts`. The frontend (`OnDeviceDisplaySection.svelte`) renders a calm `role="status"` banner (`data-testid="kiosk-unavailable"`, i18n key `onDeviceDisplay.unavailable`) when the gate fires — not an error toast.

**Kiosk dev-seam gate (T6):** `resolveActiveKioskDeps()` (exported from
`apps/backend/src/modules/system/kiosk.ts`) returns the mock kiosk harness when
`shouldUseMocks()` is true, otherwise the production `activeDeps`. The kiosk RPC
handlers call `kioskStart(resolveActiveKioskDeps())` etc. so dev exercises the full
state machine against in-memory fakes without touching `systemctl`. The gate in
`system.procedure.ts` was widened to `if (!shouldUseMocks() && !(await
isRealDevice())) return UNAVAILABLE` so dev bypasses the emulated-mode guard.
`peekMockKioskHarness()` returns the singleton without building it — use in prod
tests to assert the mock double was never constructed.

**Add-on dev-seam gate (T7):** `resolveActiveAddonManagerDeps()` (exported from
`apps/backend/src/modules/addons/manager.ts`) returns a lazily-built mock
`AddonManagerDeps` singleton under `shouldUseMocks()`, else the production
`activeDeps`. `resolveReconcilerDeps()` (exported from
`apps/backend/src/modules/addons/reconciler.ts`) mirrors the same pattern for the
post-boot reconciler. Both are the default-parameter values for their respective
public functions, so existing tests that pass deps explicitly are unaffected.

**Software-update + SSH dev mock seams (T8):**
- Production self-updates run through `software-update-process.ts` as a
  PID-1-owned transient service, never as a direct child of `ceralive.service`:
  the CeraUI package's own restart must not kill the `apt-get`/`dpkg` transaction.
  Progress comes from fixed, root-owned, no-follow mode-0600 append files under
  `/run/ceralive`, not `systemd-run --pipe` or a caller-owned scope, so the status
  parsers are not coupled to the backend process lifetime or file-read chunking.
  `RemainAfterExit` preserves the terminal result; boot verifies the exact unit id,
  transient fragment and effective `[Service]` append destinations, no-hook service
  posture, and canonical
  upgrade argv before reattaching. An
  unreadable probe fails closed before the periodic refresh and retries until it can
  resume that loop; concurrent recovery callers join one attempt. Fresh starts reject
  an existing unit and non-upgrade apt argv;
  observation errors retain independently-advanced cursors, final output must drain
  completely before cleanup (bounded exhaustion retains the unit for recovery), and
  cleanup failure is terminally visible rather than reported as success. Discovery
  is single-flight. Every apt call names `/usr/bin/apt-get` explicitly; refresh
  and read-only discovery are argv-only and locally bounded, while the detached
  install transaction remains deliberately unbounded.
- `simulateMockSoftwareUpdate()` (internal, called by `startSoftwareUpdate()` under
  `shouldUseMocks()`) broadcasts a realistic sequence of `{updating: SoftUpdateStatus}`
  frames — initial zero totals, then downloading/unpacking/setting-up counts, then
  completion — without spawning `apt-get`. The in-flight promise is accessible via
  `getMockSoftwareUpdatePromise()` for test awaiting.
- `setSoftwareUpdateRunner(runner)` (exported from `software-updates.ts`) replaces
  the default apt spawn with an injected function. Use in prod tests to assert the
  runner was called with the expected arguments without running a real update.
- `setSshServiceRunner(runner)` (exported from `ssh.ts`) replaces the default
  `systemctl start/stop ssh` spawn. The `shouldUseMocks()` branch in
  `startStopSsh()` flips `mockSshActive` and broadcasts `{ssh}` without touching
  `systemctl` or `passwd`.

**SIM PIN boot auto-unlock is another `isRealDevice()`-gated boot action.** `maybeAutoUnlockSimPins()` (`apps/backend/src/modules/modems/sim-autounlock.ts`, wired into `initModemUpdateLoop`) no-ops on a dev/emulated host. It submits the opt-in PIN — stored in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret` (`sim-secrets.ts`), never in `config.json` — at most once per locked modem, then clears the PIN and stops on any failure (no PUK-lockout loop). See `apps/backend/AGENTS.md` → SIM PIN AUTO-UNLOCK.

Override for tests: set `CERALIVE_DEVICE_TYPE=emulated` or `=real` in `beforeEach`/`afterEach` to pick the branch deterministically on any host.

## DEP BASELINE (as of 2026-08)

| Package | Version |
|---------|---------|
| `@orpc/server` (backend), `@orpc/contract` (packages/rpc) | 2.0.0-beta.31 — EXACT pin, see below |
| Bun pin (`.bun-version`) | 1.4.0 |
| `svelte` | 5.56.10 |
| `vitest` | 5.0.0-rc.3 — EXACT pin (a PRERELEASE; see the note below the table) |
| `vite` | 8.2.2 |
| `jsdom` | 30.0.1 (requires Node ≥ 24.15; satisfied by the Node 26 pin) |
| Node | **26 wherever Node runs at all** — REQUIRED baseline, not a canary. `build-check.yml`, `publish-deb.yml`, and `publish-release.yml` all pin `NODE_VERSION: "26"`; `mise.toml` and both `volta.node` fields (root + `apps/frontend`) match. No cache key is keyed on the version, so the flip needs no cache bust. The `test-fe` job is the one job with NO `setup-node` step — every command in it is Bun (see the Vitest note below). |
| `tailwindcss` (+ `@tailwindcss/vite`/`@tailwindcss/postcss`) | 4.3.3 |
| `@biomejs/biome` (via the `@ceralive/biome-config` canon) | 2.5.9 — the config dep stays the range `^2026.8.0`; canon `2026.8.1` is committed in the root repo but NOT yet published, and a `^2026.8.1` pin would fail `bun install --frozen-lockfile` today. The caret absorbs it the moment the `biome-config-v2026.8.1` tag publishes. |
| `bits-ui` | 2.19.0 |
| `@playwright/test` | 1.62.1 |
| `@lucide/svelte` | 1.33.0 |
| `@inlang/paraglide-js` | 2.24.1 — EXACT pin (root `packages/i18n` + `apps/frontend`, kept in lockstep) |
| `svelte-check` | 4.7.6 |
| `@sveltejs/vite-plugin-svelte` | 7.3.0 |
| `@axe-core/playwright` | 4.13.0 |
| `@types/node` | 26.2.0 (matches the Node 26 runtime baseline) |
| `zod` | 4.4.3 (workspace catalog) |
| `winston` | 3.19.0 |
| `vite-plugin-pwa` | 1.3.0 |
| `vaul-svelte` | 1.0.0-next.7 — pinned EXACT; the "stable" 0.3.2 is a DOWNGRADE, never bump to it |

**`vitest` is on a 5.0 RELEASE CANDIDATE, pinned exact, and it earned that by flipping a
runtime verdict — which is now ACTED ON, not merely recorded.** Under `vitest@4.1.10` the
frontend suite could not be collected under Bun at all — 110 of 281 files died on a shared
`undefined is not an object (evaluating 'z.enum')` in the Zod schema import graph — and that is
why the frontend suite ran on Node for as long as it did. Under `5.0.0-rc.3` Bun 1.4.0 runs the
current suite at **354 files / 5,779 tests, 0 failures**, matching the pre-bump `5.0.0-rc.2`
baseline exactly. Nothing in the rc.2→rc.3 release notes needed a source or config change here:
`clearMocks` now defaults to `true` and the suite is unaffected, and the repo uses none of the
removed surfaces (`test.sequential`, `vitest/reporters`/`vitest/coverage`/`vitest/suite`, `bench`
at module scope, `VITEST_WORKER_ID`, `populateGlobal`, unawaited `.resolves`). **The frontend
`test` script therefore invokes `bun --bun vitest run`, and `test-fe` has no `setup-node` step.**
The explicit `--bun` is load-bearing: `node_modules/.bin/vitest` carries a `#!/usr/bin/env node`
shebang, so a bare `vitest run` under `bun run` still executes on Node — measured, a probe test
reported `process.execPath` = node and `process.versions.bun` = `undefined` before the flip, and
bun / `1.4.0` after it. A caret would range forward into stable 5.0.0 unreviewed, so the pin is
exact; when 5.0 ships stable this pin moves, but the runtime does not have to move with it.

The same flip reaches `publish-release.yml`'s `frontend-tests` job for free, because it calls the
same `bun run --filter frontend test` script — and that job never had a `setup-node` step, so
before the flip it was running Vitest on whatever Node the runner shipped. It is now pinned to
Bun 1.4.0 like every other command in it. That job's own step ORDER is a separate, documented
contract (vitest must stay immediately after `bun install`) and is untouched.

**oRPC is pinned EXACT on a 2.0 beta.** `^2.0.0-beta.31` would range forward across betas and into stable
2.0.0, which is not acceptable for a device runtime. CeraUI is insulated from v2's biggest break — the RPC
serializer / error-body wire-format change — because `apps/backend/src/rpc/adapter.ts` speaks its own Bun
WebSocket `{id, path, input}` protocol and calls oRPC's `call()` directly; there is no `RPCHandler` or
`RPCLink` here. v2 removed `.route()`/`.prefix()`/`.tag()` from the builder (OpenAPI routing moved to
`openapi()` metadata in `@orpc/openapi`), so the push-only subscription entries in `packages/rpc/src/contracts/`
are declared as a bare `oc`. Do not reintroduce route metadata — CeraUI serves no OpenAPI surface.
Reserved router keys in v2 (`then`, `bind`, `valueOf`, `toString`, `toJSON`) must never be used as a
procedure or child-router key.

Beta.31's breaking change is likewise outside CeraUI's surface: it changes only
`CORSHandlerPlugin`'s HTTP response default from reflected origin to `*` and permits async
`origin`/`timingOrigin` resolvers. CeraUI instantiates no handler or CORS plugin; the Bun WebSocket
adapter navigates the router and invokes `call()` directly. The other beta.31 contract/server edits
are fixes (including prototype-safe error-code lookup) and do not change the `oc.router()` /
`oc.input()` / `oc.output()` declarations used in `packages/rpc`.

### TypeScript: two majors, deliberately

| Scope | Compiler | Why |
|-------|----------|-----|
| workspace catalog + `apps/frontend` | **6.0.3** | `svelte-check` refuses to start on TS 7 (`bin/ts-version-check.js`); its peer range is `^5.0.0 \|\| ^6.0.0` |
| `apps/backend`, `packages/rpc`, `packages/i18n` | **7.0.2** (direct devDep) | plain `tsc --noEmit`, no compiler-API consumer |

TypeScript 7.0 does not ship the programmatic compiler API (expected in 7.1), which is the root cause of the
one remaining TS6 holdout above. `packages/i18n` moved onto the shared 7.0.2 devDep with the rest of the
non-Svelte packages once the Paraglide cutover (todo 24) retired the `typesafe-i18n` generator and its
`ts.createProgram` postinstall hook — the earlier split-TS6/TS7 arrangement for this package (a bare 6.0.3
dep plus a `typescript-7` npm-alias `check` gate) no longer exists. The former non-blocking
`svelte-check --tsgo` canary is retired: under Bun 1.4.0 with released `typescript@7.0.2` it reported the
same **0 errors and 5 warnings in 4 files** as the required frontend check, so it added no independent signal.
Revisit the frontend TS6→TS7 move when `svelte-check` accepts the TS7 peer range and the released compiler
provides the programmatic API it consumes; do not restore an advisory native/compiler canary merely to watch
that transition.

Because two majors coexist, **never invoke a bare `tsc`** — whichever copy hoisting left in `node_modules/.bin`
would win, silently and differently per machine. Every typecheck goes through [`scripts/tsc.mjs`](scripts/tsc.mjs),
which resolves the compiler from the *invoking package's own* dependency graph (`--compiler-package <name>`
selects the alias). The Bun 1.4.0 retest resolved the current TS 7 backend and TS 6
frontend probes correctly, but `bun tsc` remains banned: only the wrapper guarantees
package-local compiler selection (oven-sh/bun#37152).

Fast-reload development loop (dev-sync / dev-push): [`image-building-pipeline/v2/docs/fast-reload.md`](../image-building-pipeline/v2/docs/fast-reload.md)

## LOCAL DEV: CONTROL-CHANNEL OVERRIDE

For local dev, set `CERALIVE_CONTROL_HUB_URL=ws://localhost:<hub-port>` and
`PASETO_PUBLIC_KEY=<raw-base64 32-byte Ed25519 public key>` in `.env.development`
to point the device-control channel at any WS hub. No source changes are needed —
both vars are read from `process.env` at runtime (`modules/remote/control-endpoint.ts`
resolves the hub URL; `modules/pairing/device-token.ts` reads the raw-base64 key).
Both are unset by default, so the control channel stays gated until provisioned.
`PASETO_PUBLIC_KEY` here is the raw-base64 encoding (node:crypto), never a PASERK
`k4.public.…` string.

## CONVENTIONS

- Linting/formatting: Biome 2.5 via `@ceralive/biome-config` — ESLint and Prettier are fully removed. The root `biome.json` extends `@ceralive/biome-config` (`"extends": ["@ceralive/biome-config"]`). Run `biome check .` (or `bun run lint`) from the workspace root. Nested non-root configs live in `apps/frontend/`, `apps/backend/`, `packages/i18n/`.
- Svelte+TS: Biome's experimental HTML/Svelte support is enabled via the shared config (`html.experimentalFullSupportEnabled: true` + `html.formatter.enabled: true`). `.svelte` files are linted by Biome; their formatter is disabled in `apps/frontend/biome.json` (`overrides`) because Biome's experimental HTML formatter rewrites the `<script>` block to double quotes and cannot parse Svelte control-flow — so `.svelte` markup is still formatted by the Svelte VS Code extension. That formatter override is unrelated to the lint one below and is not up for review.
- Svelte lint overrides are down to **exactly two** rules (re-verified 2026-08-21 against Biome 2.5.9): `correctness/noUnusedVariables` and `correctness/noUnusedImports`, both off for `**/*.svelte` because Biome still does not count template references — re-enabling the pair on 2.5.9 takes `biome check .` from **33 warnings + 3 infos** to **1,933 warnings**, i.e. **1,142 `noUnusedVariables` + 760 `noUnusedImports`** new findings (Paraglide `m["<key>"]()` imports used only in markup, such as `BufferingIndicator.svelte`, plus cascading markup-only references). The upstream gap is [biomejs/biome#8590](https://github.com/biomejs/biome/issues/8590), still open. 2.5.3 fixed `$store`/`$bindable` for `noUnusedVariables` only and 2.5.7 fixed `{@attach}`; both shipped before 2.5.9 and both are too narrow to retire the overrides. The other three historical entries are gone: `noUnusedFunctionParameters` was genuinely **re-enabled** (it found one real vestigial parameter, now fixed), while `useImportType`/`useConst` were **dead config** — both are inert on `.svelte` even when set to `"error"` directly, though `noNonNullAssertion` does fire, so this is rule-specific rather than a blanket exclusion. Full rationale, reproduction command, and the re-attempt checklist: [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) → "Svelte lint overrides". Do NOT re-add a blanket disable for a rule that is not actually firing.
- Strict TS: `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` are enabled in `tsconfig.json` (root), `apps/backend`, and `packages/rpc`. The frontend app (`apps/frontend/tsconfig.app.json`) and `tsconfig.node.json` enable `strict` + `noUncheckedIndexedAccess`; `exactOptionalPropertyTypes` is intentionally omitted there because it is incompatible with bits-ui v2 / shadcn-svelte and vite-plugin-pwa types (unfixable "union too complex" errors in CLI-managed components). The e2e tsconfig stays at baseline `strict` (ungated Playwright test code).
- Mock hardware in dev via `MOCK_SCENARIO` env var (`multi-modem-wifi` default). Use `shouldUseMocks()` — never raw `isDevelopment()` — to gate mock paths.
- `LOG_LEVEL` env var overrides the Winston transport level for ALL transports (console + file). Unset = per-transport defaults (dev console `info`, prod console `warn`, file `debug`). Set `LOG_LEVEL=debug` to enable per-RPC trace lines.
- Backend binary compiled with `bun build --compile`; target set by `BUILD_ARCH`.
- Frontend is a PWA — service worker via `vite-plugin-pwa`.
- Validation constants live in `packages/rpc/src/schemas/`; the frontend reads them via `ValidationAdapter.ts` — never add inline numeric literals to dialog components.
- All config dialogs compose `AppDialog.svelte` (desktop Dialog / mobile Sheet via `MediaQuery` from `svelte/reactivity`).
- E2E Testing: REQUIRED reading before writing E2E tests → [`apps/frontend/tests/e2e/PLAYBOOK.md`](apps/frontend/tests/e2e/PLAYBOOK.md)
- Technical debt: every debt this overhaul introduces is tracked in the machine-checkable register `docs/TECHNICAL_DEBT.md`, enforced by `scripts/check-tech-debt.mjs` (the `check:tech-debt` script, **blocking** in the `test` CI job). Any source `data-debt-id="TD-NNN"`, `coming-soon`, or in-source `[PARTIAL]` marker MUST point at an `open` register entry — an orphan marker or a malformed entry fails CI. It extends the `image-building-pipeline/v2/docs/DEFERRED.md` ledger pattern and does NOT duplicate the root status-label system (`docs/CONVENTIONS.md`). Full contract: `docs/CONVENTIONS.md` → Technical-Debt Register.

## Release & CI rules

These two rules govern how multi-repo efforts land. They COMPLEMENT — never replace
— the root workflow rules (`../AGENTS.md` Rules A–E) and CeraUI's testing gate.

**R1 — CI-green gate:** Every commit must pass lint + typecheck + Tier-1 unit tests (DB-free).
`check:tech-debt` runs on **CeraUI only** (ceralive-platform has no such script).
Every PR additionally passes Tier-2 integration tests (live Postgres/Redis) + Playwright e2e +
CeraUI backend tests + `bun run build` (platform). Tier-3 is release/manual only — NOT a PR gate.
A red gate blocks the PR; no skip/weaken of any test.

**R2 — single integration branch → one PR per repo:** All work for an effort lands on ONE
integration branch per repo (e.g. `feat/refined-experience`), stacked as wave-ordered coherent
commits. Exactly ONE PR per repo. Merge order: root policy PR → ceralive-platform → CeraUI.
Rebase onto `origin/<canonical>` between waves (Rule B); conflicts STOP-and-surface.
R2 is a COMPLEMENT to Rule C ("one focused PR per repo"), not an override.

The Build Check E2E topology is intentionally split: `setup-e2e` builds and
uploads the frontend and caches only Playwright browser binaries, while each
isolated desktop/mobile × two-shard runner installs its own Playwright OS
dependencies. Browser cache keys use the exact installed Playwright CLI version,
and the four lanes retain unique blob artifacts for the merged report. The
setup job also downloads the published `srtla-send-rs` v3.2.0 amd64 `.deb`,
verifies its pinned SHA-256 and Debian package metadata, extracts only its runtime
payload, and uploads that payload as a one-day artifact. Each E2E lane restores
the executable bit, adds the extracted `usr/bin` to `PATH`, rewrites its local
`setup.json` `srtla_path`, and asserts the real `srtla_send` binary before server
startup. No stub, `sudo` install, sibling checkout, or skipped backend preflight
is permitted. Each functional lane serves the uploaded production bundle with
one `vite preview` process on port 6173, shared by that lane's Playwright workers;
the lane's reference backend on port 3002 supports startup and global setup but
is not the backend used by functional test pages. Under CI preview only,
the E2E fixture installs an HttpOnly SameSite=Strict cookie containing its
validated 3100-3199 worker port and a random per-worker proxy secret. The proxy
consumes and strips that routing value only when the raw request target is the
literal `/ws` or `/preview` path (optionally followed by a query), injects the
secret as a proxy-only backend admission header, and fails
closed on missing/malformed routing state or explicit query/header steering.
Worker backends require the exact header before upgrading in E2E mode, so direct
browser sockets cannot connect through the shared preview to another worker's
backend. This keeps every browser paired with its worker-scoped backend, preview
upstream, and scenario. The CI lane seeds the
reference backend's password and persistent token before server startup, so
Playwright global setup never depends on a missing-cookie fallback through the
preview proxy; local global setup retains its browser-driven flow.
Runtime E2E code must use fixture RPC/socket seams and must not import Vite-only
`/src` modules. Local E2E retains `window.__ceraSocketPort`, which selects the
page's worker-scoped 3100-3199 backend; the reference backend on port 3002 is not
the functional page backend. Local Vite dev does not enable cookie routing. The
semantic YAML contract is
`bun run test:build-check-shape`.

Four further Build Check facts, all landed 2026-08-14:

- **The frontend Vitest lane runs on BUN; the Playwright lanes stay on Node 26**
  (`NODE_VERSION: "26"`, still set at workflow level and still consumed by
  `test-be`, `setup-e2e`, `test-e2e`, `merge-e2e-reports` and `build`). The Vitest
  blocker was `vitest@4.1.10`'s collection failure, not Bun's: under the
  `vitest@5.0.0-rc.3` pin the current suite is green at **354 files / 5,779 tests —
  identical to the pre-bump rc.2 baseline**, so the frontend `test`
  script now invokes `bun --bun vitest run` and `test-fe` carries no `setup-node`
  step at all. **The Playwright half is NOT flipped and has never produced a green
  parity run** — that lane keeps Node 26, and nothing here authorises moving it.
  Two consequences: this was a build-check RUN-STEP change, so the root
  workspace CI manifest set-equality model must be resynced to match; and the
  prerelease `vitest` pin is now load-bearing for a required lane, so bumping it to
  stable 5.0 means re-confirming the same-lockfile parity counts, not just editing
  the version.
- **The former `tsgo-canary` is retired.** Released TypeScript 7 is already the
  native compiler, and the Bun 1.4 probe produced no diagnostics beyond the
  required TS6 frontend check. Revisit the frontend compiler when
  `svelte-check` supports TS7's peer/API surface; do not recreate an advisory
  canary without a demonstrated additional signal.
- **`setup-e2e` typechecks and measures before it uploads**: `bun run --filter
  frontend check` gates the build, and `bun scripts/ci/bundle-report.mjs` fails
  the job when the initial-route JS gzip set exceeds its documented budget.
- **The e2e exclusion tag list lives in TWO files** — the root `test:e2e` script
  and the Functional E2E step's `--grep-invert`. Both carry
  `@visual|@a11y|@gallery|@premigration-upgrade`; change one and you must change
  the other (and the workspace manifest legs with it).

Any change to this workflow's jobs or run steps also changes the workspace
manifest — the build-check manifest and execution contract tests model the job set and
per-job run-step digests with SET EQUALITY and fail on anything unmodeled.

## BUN-NATIVE CONVENTIONS (as of 2026-06)

The backend is fully migrated to Bun-native APIs. Use these patterns for all new backend code:

- **Process spawning**: `Bun.spawn()` / `Bun.$` (shell) / `Bun.spawnSync()` — NOT `node:child_process`
- **File I/O**: `Bun.file().text()` / `Bun.write()` — NOT `fs.readFileSync` / `fs.writeFileSync`
- **HTTP client**: `fetch()` with `AbortSignal` — NOT `node:http`
- **Crypto**: `randomBase64()` from `src/helpers/crypto.ts` — NOT `crypto.randomBytes`
- **Keep on `node:`**: `node:path`, `node:os`, `node:dns`, `node:assert`, `node:events` — fully supported, no Bun gain
- **Keep on `node:fs/promises`**: directory ops (`readdir`, `mkdir`) — `Bun.file().exists()` is file-only and returns `false` for directories
- **`Bun.$` shell interpolation**: dynamic command strings must use `Bun.$\`${{ raw: cmd }}\`` — plain `${cmd}` escapes the whole string into one quoted arg
- **`process.env` writes**: stay on `process.env` — `Bun.env` is read-only

## CAPABILITY CONSUMER [EXISTS]

CeraUI is the strict consumer of the `get-capabilities` IPC contract emitted by
`cerastream`. The backend calls `get-capabilities` (a post-hello JSON-RPC method on
the UDS control plane) and forwards the tiered response to the frontend. The frontend
renders only the intersected offered set:

```
platform caps ∩ capture-source caps ∩ current-mode → offered set
```

Options outside the offered set are shown **disabled with a reason tooltip** — never
hidden, so operators can see what the hardware doesn't support and why.

**`pipeline-sources.ts` per-board tables deleted [EXISTS].** The static per-board
capability tables that previously lived in `pipeline-sources.ts` are removed. All
capability data is now derived from the `get-capabilities` response at runtime. Do not
re-add static board tables; the contract is the single source of truth.

**Capability-first live experience [EXISTS].** The capability-first-live-experience
track deepened the contract to Tier-2 per-device modes and dropped the preset shortcut:

- The `capabilities` broadcast now carries per-device `device_modes` (folded from the
  engine `list-devices` `caps[]` in `capabilities.ts`, keyed by `input_id`, framerates
  normalized to rungs and bitrate normalized to kbps at ONE seam) plus
  `network_embedded_audio`. The offered set is now `platform ∩ active-source ∩ Tier-2
  device modes`; with `device_modes` absent it degrades to the coarse offering
  (old-engine fallback), never a fully-disabled axis set.
- The `status` broadcast carries a typed `audio_sources` list (`deriveAudioSources`)
  beside the legacy `asrcs` — pseudo-sources (`No audio`/`Pipeline default`) carry a
  `labelKey`; device entries stay untranslated. `config.asrc` wire value is unchanged.
- The mode-preset catalog is fully removed (`CANONICAL_PRESETS`/`modePresets.ts`/the
  `data-testid="mode-presets"` grid/`live.presets.*` keys are gone). `EncoderDialog` is
  now capability-first with independent, disabled-with-reason axes; `SourceSection`
  surfaces rtmp/srt LAN ingest as first-class source rows (`source-network-ingest-*`,
  with `NetworkIngestSection` the detailed QR/instructions card), and an rtmp/srt
  pipeline's embedded audio (`network_embedded_audio` + pipeline `audio_kind:
  'embedded'`) renders the read-only "Embedded audio" state, else a `TD-embedded-audio`
  coming-soon pill.
- The rendered-DOM truth of all of the above is locked by the capability-truthfulness
  e2e gate (`apps/frontend/tests/e2e/truthfulness.spec.ts`) — extend it, don't fork it.

**Source-experience overhaul [EXISTS].** The Live destination's source-selection,
encoder-configuration, and server-destination surfaces were overhauled as part of the
ceraui-source-experience / ceraui-receiver-experience tracks (Tasks 1–16). New
components and modules shipped:

- `apps/frontend/src/lib/components/custom/SourceSection.svelte` — live input picker
  section; renders the active source, a live-switch affordance, and the PiP/fallback
  coming-soon pills.
- `apps/frontend/src/lib/components/custom/ComingSoon.svelte` — calm roadmap pill +
  tooltip; takes a `debtId` prop and renders `data-debt-id` into the DOM. Every
  instance MUST point at an `open` entry in `docs/TECHNICAL_DEBT.md`.
- `apps/frontend/src/lib/components/custom/InfoPopover.svelte` — lightweight info
  popover (question-mark trigger + tooltip body); used by SourceSection and
  CapabilityTierBanner.
- `apps/frontend/src/lib/streaming/sourceSummary.ts` — derives a human-readable
  source summary string from the active config for the HUD and Live header.
- `apps/frontend/src/lib/streaming/liveAudioSwitch.ts` — live audio switch gate;
  `isAudioLiveSwitchEnabled(caps)` is the single source of truth for the
  `TD-live-audio-switch` capability check.
- `apps/frontend/src/lib/rpc/streaming-optimism.svelte.ts` — optimistic streaming
  state machine; bridges the gap between `startStream` RPC dispatch and the first
  `is_streaming=true` push so the UI never flickers back to idle mid-start.
- `apps/frontend/src/lib/streaming/receiver-experience.ts` — pure, rune-free module
  for the receiver-experience track. Exports: `Destination`, `deriveDestination`,
  `resolveReceiverKind`, `kindBadgeLabelKey`, `buildServerSetConfig`,
  `ServerReadiness`, `deriveServerReadiness`, `buildServerSummary`. The single source
  of truth for destination derivation, kind-badge i18n keys, and the field set sent
  to `streaming.setConfig` on save.
- `apps/frontend/src/main/dialogs/server/DestinationSection.svelte` — destination
  radiogroup (managed vs custom); provider-aware label from `config.remote_provider`.
- `apps/frontend/src/main/dialogs/server/CustomEndpointForm.svelte` — custom/manual
  endpoint fields driven by `receiverKindManifest(kind)` (addr, port, optional stream
  ID, optional secret for SRTLA/SRT custom).
- `apps/frontend/src/main/dialogs/server/TransportBadge.svelte` — transport summary
  chip + Advanced disclosure for protocol selection; reads `getCapabilities()` itself.
- `apps/frontend/src/main/live/ServerReadiness.svelte` — SRTLA bonded/single-link
  readiness hint in the Live destination; driven by `deriveServerReadiness`.
- `apps/frontend/src/main/live/LiveHeader.svelte` — Live header chip showing the
  active destination + kind badge; opens `ServerDialog` on tap.

**Source-priority reorder UI removed (live-correctness-pass Todo #10).** The
pre-start source-preference reorder affordance is GONE from the frontend:
`lib/streaming/source-preference.ts`, `SourcePreference.svelte`, and their tests
are deleted (every remaining importer was itself one of the deleted files). The
backend `source_preference` config field is KEPT for wire compat (still
persisted/echoed by `streaming.procedure.ts`) — an old client can still write it;
nothing in CeraUI writes or reads it anymore. `SourceSection.svelte`'s unified
`<ul>` renders sources in broadcast order — no rank sort, no drag handles.

**Track-1 tech-debt register [EXISTS].** Items from this overhaul are tracked in
`docs/TECHNICAL_DEBT.md` and enforced by `scripts/check-tech-debt.mjs`. Three remain
open; two are resolved (Task 26):

| ID | Feature | Status | Exit condition |
|----|---------|--------|----------------|
| `TD-live-audio-switch` | Live audio source switch | resolved 2026-06-17 | `capability:audio_live_switch` |
| `TD-live-audio-delay` | Live audio delay change | resolved 2026-06-17 | `capability:audio_live_switch` |
| `TD-live-audio-codec` | Live audio codec change | open | `capability:audio_codec_switch` |
| `TD-pip` | Picture-in-picture / compositing | open | `capability:pip_supported` |
| `TD-mode-fallback` | Mode-level automatic source fallback | open | `capability:mode_fallback` |
| `TD-plain-srt-egress` | Plain-SRT (non-SRTLA) receiver egress | open | `capability:srt` |

Open items are `track: 2` (cerastream engine dependency) and carry `coming-soon`
affordances in the Live destination. The CI gate (`check:tech-debt`) fails if any
source `data-debt-id` is orphaned or any entry is malformed.

**Relay transports + RIST protocol [EXISTS].** The capability contract carries a
`transports` list (the relay transports the engine can honor; always includes
`srtla`). The capability service derives it (`getSupportedTransports()` is the sync
backend gate source) and broadcasts the snapshot in the `capabilities` event. The
transport resolver promotes `rist` from a reserved placeholder to an active protocol
(`apps/backend/src/modules/streaming/transport/rist-adapter.ts`, RIST simple-profile:
even data port) gated on `ristAvailable` in `resolveStreamEndpoint`; `srt` stays
reserved. The shared selectability rule lives in `@ceraui/rpc/schemas`
(`relayProtocolAvailability`). `ServerDialog` renders the SRTLA/SRT/RIST selector
via `ProtocolSelector.svelte` (always-visible radiogroup, **above** the endpoint
section — protocol-first reorder, T21-T23): RIST is shown **disabled with a reason**
until the engine advertises the `rist` transport, SRT is always reserved
(`data-debt-id="TD-plain-srt-egress"`, calmed styling, CI-enforced) — never hidden.
`TransportBadge` is now a read-only summary chip that reflects the active protocol;
it is no longer the protocol entry point and no longer hosts an Advanced disclosure.

**Protocol-first receiver-experience overhaul [EXISTS].** `ServerDialog` was
rewritten as a destination-first container (ceraui-receiver-experience track, Tasks
1–14) and subsequently updated to a protocol-first layout (T21-T23): the protocol
selector is now promoted above the endpoint fields, making transport choice the
second decision after destination. Key concepts:

- **Receiver-kind model** (`packages/rpc/src/schemas/relay.schema.ts`): every stream
  destination is one of `srtla_relay`, `srtla_custom`, `rist_relay`, `rist_custom`,
  or `srt_custom`. `deriveReceiverKind` derives the kind from the current config;
  `receiverKindManifest(kind)` describes which fields are required and whether the
  kind is bonded or single-link. See [`docs/RECEIVER_MODEL.md`](docs/RECEIVER_MODEL.md)
  for the full model and the Scope-B plain-SRT contract.
- **Transport × destination model**: the two axes are independent. Destination
  (`managed` relay vs `custom` endpoint) is chosen first; transport (SRTLA / RIST /
  SRT) is chosen second via the always-visible `ProtocolSelector` rendered ABOVE the
  endpoint fields (protocol-first reorder, T21-T23) — no longer inside `TransportBadge`,
  which is now a read-only summary chip. A managed relay may advertise
  multiple protocols via `server.protocols`; the dialog seeds the best available
  default when the selected server's protocol set excludes the current draft.
- **`relay.validate` mock seam (T4)**: `apps/backend/src/rpc/procedures/relay.procedure.ts`
  exposes a `relay.validate` procedure that runs ordered stages (`input` → `protocol`
  → `endpoint` → `dns` → `probe`). The `dns` and `probe` stages are stubbed by the
  mock seam (`shouldUseMocks()` gate) so integration tests can exercise the full
  validation pipeline without real DNS or UDP reachability. See
  `apps/backend/src/mocks/providers/relay.ts` for the mock provider.

**New `server/` sub-components [EXISTS]:**

- `apps/frontend/src/main/dialogs/server/DestinationSection.svelte` — presentational
  radiogroup (managed vs custom); provider-aware label driven by `config.remote_provider`
  (set in `CloudRemoteDialog`); D6-gated (managed disabled when no relay servers are
  configured or while streaming).
- `apps/frontend/src/main/dialogs/server/ProtocolSelector.svelte` — always-visible
  radiogroup for protocol selection (SRTLA / RIST / SRT); rendered **above** the
  endpoint section in `ServerDialog.svelte` (protocol-first reorder, T21-T23). Reads
  `getCapabilities()` itself. RIST is disabled-with-reason until the engine advertises
  the `rist` transport; SRT carries `data-debt-id="TD-plain-srt-egress"` (calmed
  styling, CI-enforced via `check:tech-debt`) and is never hidden.
- `apps/frontend/src/main/dialogs/server/CustomEndpointForm.svelte` — field set for
  custom/manual endpoints; fields driven by `receiverKindManifest(kind)` (addr, port,
  optional stream ID, optional secret for SRTLA/SRT custom).
- `apps/frontend/src/main/dialogs/server/TransportBadge.svelte` — read-only summary
  chip showing the active receiver kind via `kindBadgeLabelKey` (from
  `lib/streaming/receiver-experience.ts`) and a bonding readiness line for SRTLA.
  Demoted to a summary chip in T21-T23: it is no longer the protocol entry point and
  no longer hosts an Advanced disclosure for protocol selection.

**Scope decisions (record for future agents):**

- **HUD bar does NOT surface the server target.** The persistent `HudBar.svelte` shows
  bitrate, per-link signals, and SoC telemetry only. The Live header chip
  (`main/live/LiveHeader.svelte`) and the Live destination summary row own the
  server-target display. Adding server-target to the HUD is explicitly out of scope
  and would duplicate the Live header.
- **Provider-switch stale-`relay_server` (surfaced, T18).** `DestinationSection`
  labels the managed option using `config.remote_provider` (set by `CloudRemoteDialog`).
  If the operator switches provider in `CloudRemoteDialog` without clearing the server
  selection in `ServerDialog`, the persisted `relay_server` may reference a server from
  the previous provider's relay list. The dialogs DELIBERATELY do not auto-clear
  `relay_server` (no silent mutation of the operator's config) — instead the staleness
  is now made VISIBLE on both surfaces (T18): `CloudRemoteDialog` shows a
  `relay-provider-stale-warning` band when the chosen provider no longer owns the saved
  server, and `ServerDialog` shows a `relay-stale-warning` band in the managed branch.
  The staleness rule is the pure `isRelayServerStaleForProvider(relay_server, entries,
  provider)` in `receiver-experience.ts` (a saved id absent from the catalog, or tagged
  to a different managed cloud, is stale; empty/untagged-legacy never is). Both call
  sites MUST guard on a loaded catalog (`getRelays() !== undefined`) so a still-loading
  relay list never false-warns. A related T18 warning, `relay-override-warning`
  (`overrideClearsManagedBinding`), fires before save when a manual-endpoint override
  on a bound managed server would drop the `relay_server` binding.
- **Device ↔ cloud-OBS association is read-only (T17).** A platform-managed ingest
  slot may carry an `obsInstanceId` + `instanceLabel` naming the cloud OBS instance it
  feeds. `obsInstanceAssociation(account)` (`receiver-experience.ts`) surfaces a calm
  read-only line — under each slot in `ServerIngestSlots.svelte`
  (`data-testid="obs-instance-association"`) and appended to the Live server summary by
  `buildServerSummary` — copy `settings.feedsCloudObsInstance` (10 locales). It renders
  only when BOTH `obsInstanceId` is non-null AND `instanceLabel` is non-empty; an
  unbound slot shows nothing. The device only OBSERVES the binding the platform pushes —
  there is **NO device-side OBS control** (no start/stop, no scene switch). On the cloud
  side each endpoint also carries a `sourceKind` (a device feed = `DEVICE`); CeraUI
  neither sets nor reads it. Full model: [`docs/RECEIVER_MODEL.md`](docs/RECEIVER_MODEL.md) §6.

**Plain-SRT / RIST roadmap.** Plain-SRT egress requires three layers to land together
(capability advertisement, real `srtAdapter`, and a `startStream` protocol branch).
Full spec: [`docs/RECEIVER_MODEL.md`](docs/RECEIVER_MODEL.md) §3. Tracked as
`TD-plain-srt-egress` in [`docs/TECHNICAL_DEBT.md`](docs/TECHNICAL_DEBT.md).

**Tier-4 add-on compat [PARTIAL].** Add-on compatibility is resolved entirely inside
CeraUI and is NOT part of the `get-capabilities` response. Three enforcement layers:

- `compatibleHardware` field in `AddonDescriptorSchema` gates which boards may enable
  an add-on (server-side enforcement in `apps/backend/src/modules/addons/manager.ts`
  — not UI-only).
- `deps[]` / `conflicts[]` in `AddonDescriptorSchema` are enforced at enable time
  (previously declared but unenforced).
- In-UI docs: incompatible add-ons show a reason tooltip explaining the hardware or
  dependency constraint.

**Recent enhancements [PARTIAL]:**

- **SIM PUK recovery** — UI flow for entering the PUK code when a SIM is PUK-locked.
- **SIM PIN auto-unlock** — `maybeAutoUnlockSimPins()` submits the opt-in PIN (stored
  in the chmod-600 tmpfs file `/run/ceralive/sim-pin.secret`, never in `config.json`)
  at most once per locked modem on boot, then clears the PIN and stops on any failure.
  See `apps/backend/src/modules/modems/sim-autounlock.ts`.
- **Ingest sparklines** — fixed ~60-sample in-memory ring buffer per link; no
  persistence. Rendered in the HUD bar as a compact bitrate history.
- **Session summary** — post-stream summary panel showing duration, average bitrate,
  and per-link stats for the completed session.
- **EncoderDialog modal preview (#72)** — live encoder settings preview rendered inside
  the EncoderDialog modal before the user applies changes.

## THE GATES HAVE AN OPERATOR SURFACE [EXISTS]

The seven capability modules are DEFAULT-ABSENT on every device, and for a long
time there was no way to turn one on. The band-lock and GPS controls said so
correctly — *"Band locking is turned off on this device"*, *"Turn on location for
this device in settings first"* — and pointed at a setting that existed nowhere:
board validation swept `#settings` and matched **zero** testids against
`modem|cellular|location|gps|band|capab`
(`.omo/evidence/task-49-full-stack-board-validation.md`). Both controls were
unreachable on every board regardless of what the hardware could do.

`modems.getCapabilities` / `modems.setCapabilities` plus
`apps/frontend/src/main/dialogs/ModemCapabilitiesDialog.svelte` (Settings →
System → **Cellular Features**) are that surface. Five rules carry it:

- **THE GATES ARE DEVICE-WIDE, so this is Settings and NOT a per-modem section.**
  `config.modem_capabilities` is one object every modem's claim resolves against,
  so a section inside `ModemConfigDialog` would imply the switch is scoped to the
  row in front of the operator while silently arming the module on every other
  modem too.
- **A GATE IS A PRECONDITION, NEVER A CLAIM — this bypasses no evidence gate.**
  It is one of four inputs to `resolveSupportClaim`, so an enabled gate cannot
  promote a module past `enabled` on a modem whose probe has not positively
  answered, cannot reach `certified` at all, and leaves band-lock's stricter
  certification floor refusing exactly as before. The dialog SAYS so on screen
  (`modem-capabilities-honesty`) rather than letting an on switch read as a
  promise.
- **ONLY IMPLEMENTED MODULES GET A ROW** (`DESIGN.md` CT-1). A module this build
  does not ship renders ZERO nodes — never a disabled switch, which would imply a
  capability being withheld — and a write for one is REFUSED
  (`module_not_implemented`) rather than persisted, because its key is read by
  nothing. This is why `implemented` rides the wire: a modem row resolves "not
  built" and "this hardware lacks it" both to `unavailable`, and only the device
  can tell them apart.
- **The procedures are `authedProcedure`, deliberately NOT `modemProcedure`.**
  The gates are a property of the DEVICE, so they must be readable and writable
  while the cellular stack is still initializing or with no modem attached —
  gating them behind the cellular readiness middleware would make the settings
  surface unreachable in exactly the state an operator opens it to fix.
- **A PROBE THAT PROVES A CAPABILITY RE-PUBLISHES THE ROSTER, change-gated.**
  The probes fill caches the SYNCHRONOUS wire build reads, so a read that first
  proves a capability would otherwise leave the claim stale until the 30 s poll —
  landing on the operator at the worst moment, having just enabled the gate.
  `noteCapabilityEvidenceChanged` (`capability-gates.ts`) is the seam; it DEFAULTS
  TO INERT and is installed at module scope by `capability-evidence.ts` with a
  DYNAMIC import of `modem-status.ts`, because a static edge back would cycle
  through the wire producer. Re-reading an already-proven modem broadcasts
  nothing.

Coverage: `apps/backend/src/tests/modem-capability-settings.test.ts` (the total
read, the per-module write and its config-key mapping, every refusal arm asserting
the write provably never happened, the four not-a-bypass claims, the change-gated
notifier, and a static wiring lock on the re-broadcast),
`apps/frontend/src/main/dialogs/ModemCapabilitiesDialog.test.ts` (CT-1 both ways,
the pessimistic switch, the calm refusal band, the read-failure band),
`apps/frontend/src/tests/modem-capability-copy-completeness.test.ts` (copy for all
SEVEN modules × 10 locales, derived from the wire enum), and
`apps/frontend/tests/e2e/modem-capabilities-settings.spec.ts` (the audit's own
`#settings` testid sweep, inverted, plus the real RPC round-trip).

## HOTSPOT QR SURFACE — ONE QR, AND IT IS ESCAPED [EXISTS]

`HotspotDialog` renders exactly ONE QR: the WiFi-join code carrying the live
hotspot credentials (`generateWifiQr`, gated on `isActive`). **Do not add a second
one.**

The connect-your-phone section (#67 Phase-0) that used to sit beneath it — a
device-access QR encoding `http://<gatewayIp>/` so a joined phone could open
CeraUI — is REMOVED by explicit product decision after live board QA: two QR codes
in one dialog read as noise, and the operator has to join the hotspot before the
second one is reachable anyway. The removal took its whole stack with it, all of
which had exactly one consumer: `ConnectPhoneSection.svelte` + its test, the
`connect-phone.visual.spec.ts` e2e, the `wifi.hotspotInfo` RPC (procedure, router
registration, `client.ts` binding, `HotspotInfoOutput`/`HotspotInfo` schema,
`modules/wifi/wifi-hotspot-info.ts`, and its backend test), and the five
`network.hotspot.connectPhone*` / `deviceAccessQrLabel` / `navigateManuallyNote` /
`hotspotOffPrompt` i18n keys across all 10 locales.

`generateDeviceAccessQr` is deliberately UNTOUCHED — it is a shared helper with
three other live consumers (`NetworkIngestSection`, `SourceSection`,
`CloudRemoteDialog`) and nothing to do with the hotspot.

**`generateWifiQr` escapes the four WIFI-QR reserved characters.** The payload is
`WIFI:T:<enc>;S:<ssid>;P:<password>;;`, and the de-facto standard ZXing (and every
phone camera that follows it) parses `\`, `;`, `,` and `:` as field structure — so
a hotspot name or password containing one of them must carry a backslash before it
or the scanner reads a field boundary mid-credential and joins the wrong network,
or none at all. Nothing validates the hotspot name/password against those
characters, so this is reachable by any operator who picks one. `escapeWifiQrField`
does it in ONE pass over a character class, and that is load-bearing: escaping the
four in sequence would re-escape the backslashes the earlier steps just inserted.
Coverage: `NetworkHelper.test.ts` asserts the EXACT payload string handed to the QR
encoder — including a plain-alphanumeric regression guard proving today's board
credentials are byte-unchanged.

## STREAMING BACKEND QUALITY [EXISTS]

Quality improvements landed in `chore/backend-quality` (Tasks 5–7, 13–14).

### streamloop module split

Public stream start/stop admission now routes through
`apps/backend/src/modules/streaming/stream-session-orchestrator.ts`. It owns the
single lifecycle state machine for UI, autostart, remote control, and set-profile,
uses generation-scoped cancellation for stop-during-start, and reconciles the
actual cerastream state at boot/reconnect. Query/subscription failure or a
transitional/contradictory status remains `reconciling` until the heal path retries.
After a successful status subscription, a full 2.5-second window with no event is
authoritative idle because active streams emit a 2-second heartbeat; late events
from that closed probe are fenced. `status.stream_lifecycle` is additive;
legacy `is_streaming` flips true only after engine confirmation. The bounded retry
runner retries only connect-phase transient classes, after transactional rollback,
and stop cancels a pending backoff without notification.

`apps/backend/src/modules/streaming/streamloop.ts` is now a 5-line barrel re-exporting
from `streamloop/index.ts`. The 10 public exports are unchanged — all caller import paths
are unmodified.

```
modules/streaming/streamloop/
├── exec-paths.ts    # srtlaSendExec constant
├── process-runner.ts # mutable streamingProcesses list + spawnStreamingLoop/stopProcess/stopAll/getStreamingProcesses
├── start-stream.ts  # startStream — spawns srtla_send, wires telemetry, starts the engine session over the seam
├── session.ts       # start / stop + removeNetworkInterfacesChangeListener module-state
├── autostart.ts     # AUTOSTART_CHECK_FILE / setAutostart / checkAutoStartStream / autoStartStream backoff
└── index.ts         # named re-export barrel (exactly the 8 public exports)
```

**Locked public API surface (8 exports):** `AUTOSTART_CHECK_FILE`, `autoStartStream`,
`checkAutoStartStream`, `setAutostart`, `srtlaSendExec`, `start`, `startStream`, `stop`.
Adding or removing any of these is a breaking change.

### Transactional start/stop lifecycle

The Todo-25 start taxonomy is wired through one Todo-26 session orchestrator and
the Todo-27 launch transaction. Initial IP-list preparation is awaited before
sender spawn. Sender, telemetry, control client, subscription, and accepted
engine start register cleanup immediately; failure unwinds them in reverse order
and leaves lifecycle/status idle. The start response is emitted only after the
engine confirms PLAYING. A direct start reply with `state: "streaming"` is an
authoritative confirmation; every other schema-valid reply (including
`state: "starting"`) remains in `playing-wait` until a subscribed status heartbeat
reports the concordant pair `state: "streaming"` plus `streaming: true`. If that
heartbeat misses the 5-second phase deadline, start returns typed
`start_timeout` and rolls back. Connect/subscription cleanup is attached to each
acquisition promise before its deadline race, so a resource delivered after
rollback is closed immediately and cannot become backend-owned.

Connect and hello share the published binding's combined operation and are
classified by machine-readable error shape; CeraUI does not simulate a separate
hello I/O wait. Subscribe, start-RPC, PLAYING validation, and stop have explicit
bounds. Stop confirms engine/process cleanup or returns typed `stop_failed` after
12 seconds. Full contract and timeout values: `docs/START-LIFECYCLE.md`.

Todo 28 adds a 5-attempt/60-second exponential retry bound around that transaction.
Each individual launch is also capped at 10 seconds; expiry cancels that launch's
generation, awaits bounded cleanup, and classifies the attempt as a retriable
connect-phase `start_timeout` so a hung engine call cannot hold the lifecycle slot.
The prior launch must settle after cleanup before backoff is armed; if it does not
settle within the cleanup bound, `start_cleanup_timeout` is terminal and no later
attempt is launched.
Cerastream stop is the deliberate exception to the backend IPC queue: it is sent
immediately through the active client so cleanup cannot wait behind the launch it
must interrupt. The client is then closed without waiting for a stop reply; this
settles pending start/stop requests and releases the serialized queue even when a
crashed engine can no longer answer.
Suppression reads only existing update, engine capability, and boot-uptime signals;
suppressed attempts remain `starting` and emit no error toast. Structured retry and
terminal records carry attempt id, phase, class, optional engine code, and retry
state. User copy is keyed across all 10 locales, and terminal copy points at the
in-app log viewer (Settings → System Logs) — never at `journalctl`, a systemd unit
name, or any other shell command, and never at the engine's raw diagnostic string;
that detail rides the structured record into the log the dialog downloads.
Autostart's no-link loop is capped at five checks; permanent
configuration/engine failures stop immediately with a visible reason.

**A bounded pre-engine gate DEFERS the per-attempt deadline — it never loses to it.**
The 10 s launch cap bounds engine work, but the audio-source probe
(`AUDIO_PROBE_TIMEOUT_MS`, 15 s) runs BEFORE any engine IPC and deliberately waits
longer, so the generic deadline used to fire first and report a permanently-absent
audio device as a retriable connect-phase `start_timeout` — five rounds of
"Streaming engine did not answer in time" for an engine that was never contacted
(found live on a board). `runStartWithRetry` therefore takes a
`pendingGateRemainingMs` seam: when the deadline fires while a bounded pre-engine
gate still has grace left, it RESCHEDULES itself past that grace (plus a small
slack) instead of timing out. The production orchestrator wires it to
`asrcProbeRemainingMs()` (`modules/streaming/audio.ts`). The seam's contract is
that the value MUST be bounded by the gate's own hard timeout — an unbounded
implementation disables the attempt deadline entirely. Do NOT "fix" a future
instance of this by shortening the gate or lengthening `attemptTimeoutMs`
globally: the first weakens a real grace window, the second halves the retry
count available to a genuine engine-restart race.

**`audio_source_unavailable` is the probe's own terminal class.** It is
non-retriable on every phase (`START_FAILURE_RETRIABILITY`): the probe ALREADY
spent its grace window waiting, so retrying re-runs the same wait against the same
absent hardware. `startStream` returns it on the failure result as `failureClass`,
and the three launch wrappers (`streaming.procedure.ts`, `streamloop/autostart.ts`,
`remote-control/set-profile-wiring.ts`) pass it through `typedStartFailure()`
rather than re-deriving a class from the opaque `error` string. The legacy
`error: "audio_source_probe_failed"` wire value is unchanged, so the existing
`live.startFailed.audio_source_probe_failed` copy still resolves.

### timing-constants.ts

`apps/backend/src/modules/streaming/timing-constants.ts` centralizes all hardcoded
timeout/retry values. Import from here — never add inline numeric literals to streaming
modules.

| Constant | Value | Used in |
|----------|-------|---------|
| `AUTOSTART_RETRY_DELAY` | 1000ms | `streamloop/autostart.ts` |
| `AUDIO_SOURCE_POLL_DELAY` | 1000ms | `audio.ts` |

### Logger (`apps/backend/src/helpers/logger.ts`) [EXISTS]

All `console.*` calls in streaming and ingest/rpc modules are replaced with the Winston
logger. Empty catches now log via `logger.debug`/`logger.warn` before suppressing. No
`console.*` calls remain in `modules/ingest/` or `modules/streaming/` (verified by grep
gate).

**Dev console (TTY-gated colorized pretty-print):**
`formatConsoleEntry(info, useColor)` emits `HH:MM:SS.mmm LEVEL message` with 2-space-indented
JSON metadata on subsequent lines. Color is raw ANSI (no chalk/picocolors dep) — error=red,
warn=yellow, info=green, debug=dim. `shouldColorizeConsole()` gates on
`isDevelopment() && process.stdout.isTTY`, evaluated per-record so CI/piped/prod never emit
ANSI escapes.

**Prod JSON schema (file transport + prod console):**
`formatProdEntry(info)` serializes to a single-line JSON record with a fixed shape:
```ts
{ ts: string, level: string, msg: string, module?: string, meta?: Record<string, unknown> }
```
`ts` is ISO-8601 UTC; `module` is promoted to top-level (not buried in `meta`); all other
non-reserved fields fold under `meta`. `jsonReplacer` surfaces `Error` objects as
`{name, message, stack}` rather than `{}`. Both the file transport and the production
console use this same schema so log shippers parse one format.

**`LOG_LEVEL` env override:**
`resolveLogLevel(defaultLevel)` reads `process.env.LOG_LEVEL` (non-empty, trimmed) and
applies it to EVERY transport when set. Defaults: dev console `info`, prod console `warn`,
file `debug`. Set `LOG_LEVEL=debug` to enable per-RPC trace lines in production.

**Per-RPC call tracing (`rpc/rpc-logging.ts`):**
`instrumentRpcCall` wraps every oRPC procedure dispatch with a debug-level trace line
carrying `{ procedure, cid, latency_ms, ok }`. Gated on `isRpcTraceEnabled()` (dev or
`LOG_LEVEL=debug`) so a shipped device never pays the per-call cost. Auth procedures
(`auth.*`) have their args omitted entirely — not even redacted-partial. All other
procedure args pass through `logRedact()` before logging.

**Adapter diagnostics (T3):**
`extractValidationDetails(error)` (exported from `apps/backend/src/rpc/error-enrichment.ts`)
turns an opaque oRPC/Zod validation failure into a structured `ValidationDetails` shape:
`{ phase: "input" | "output" | "unknown", issues: ValidationIssueDetail[] }`. The WS
adapter calls it in its catch block and attaches the result as a `validation` field on
the `RpcCallTrace` log record. These adapter diagnostics let you see exactly which
schema field failed and whether it was an input or output validation error. Phase is
classified from the oRPC wrapper message ("Input/Output validation failed") then the
error code as a fallback. Issue paths are schema field names (safe); messages are
scrubbed through `logRedact` before logging. Returns `undefined` when the error has no
issue list, so callers omit the field rather than log an empty record. See
`apps/backend/AGENTS.md` → DEV MOCK SEAMS for the full contract.

**Boot banner + per-phase markers (`helpers/boot-banner.ts`):**
`buildBootBanner(info)` emits a one-line startup banner: `🎬 CeraUI vX · env=… · scenario=…`.
`createBootTimer()` tracks per-phase deltas (injectable clock for tests). `main.ts` emits
7 phase markers (🔧 config / 🔌 pipelines / 🖥️ hardware / 🌐 network / 🎵 audio & devices /
🚀 server / ▶️ autostart & reconciler) and a final `✅ CeraUI ready on port N in Xms` line.

**Secret redaction (all transports):**
`redact()` format scrubs every record before it reaches any transport. Keys matching
`/pin|password|token|secret|paseto|bcrp|auth/i` are replaced with `[REDACTED]`. Value-shaped
secrets (PASETO `v4.public.*`, JWT `eyJ…`, Bearer credentials) are also scrubbed from string
values. The `logRedact(value)` helper is exported for call sites building metadata objects.

**Loop visibility:**
Streaming and ingest loop modules log entry/exit and error paths via `logger.debug`/`logger.warn`
so the boot sequence and per-tick activity are visible in dev without noise in prod.

## INGEST HARDENING [EXISTS]

Quality improvements to the ingest pipeline landed across Tasks 6, 19, and 23.

### Export-failure handling

`IngestStats.svelte` catches `URL.createObjectURL` / `Blob` failures during JSON/CSV
export and renders a calm amber bordered band (`ingest-export-error`) instead of
silently swallowing the error. The error state is driven by a local `exportError`
slot and clears on the next successful export.

### Sparkline memoization (`lib/components/custom/ingest-link-view.ts`)

The per-link SVG sparkline computation is extracted into a pure rune-free module.
`createLinkViewCache()` keeps a `Map<conn_id, {ref, view}>` and recomputes only when
the samples-buffer reference differs from the last call for that `conn_id`. The ring
effect allocates a fresh array only on append (`[...prev, sample]`), so a stable
reference means unchanged samples and a memo hit; a genuinely new sample swaps the
reference and triggers exactly one recompute. The cache is per-component-instance
(freed on unmount) — no module-global state, no unbounded growth.

`EMPTY_SAMPLES` is a shared stable empty buffer so a link awaiting its first frame
is also a memo hit. `RING_CAPACITY` (60 samples), `SPARK_W`, `SPARK_H`, and the
`Sample` / `LinkViewComputed` types are all exported from this module — never
duplicated in the component.

### Visual/UX polish (Task 23)

`IngestStats.svelte` markup was polished without changing any data logic, thresholds,
or `Props`:

- Header: phosphor-lime icon chip + count/sample pill.
- Per-link table: spectral identity dot (CSS `--link-1..6` ramp) before each iface;
  column headers aligned past the dot.
- Sparkline strip: leading `Trend` micro-label (i18n key `live.ingest.trend`, added
  to all 10 locales), taller `h-6`, neutral baseline `<line>` (NOT a second
  `<polyline>` — keeps `spark.locator("polyline").toHaveCount(1)` valid).
- Health verdict: pill with a leading dot (lime healthy, amber degraded).
- Alert + export-error: calm amber bands with icon.
- Summary: stat tiles with icons; drops value goes amber when `> 0`; per-link uptime
  rows gain a `--primary` progress bar.

### @visual spec (`tests/e2e/visual/ingest-states.visual.spec.ts`)

5 desktop visual tests (tag `@visual`): idle / streaming / summary / health-alert /
export-error. Each captures one PNG to `apps/frontend/test-results/`. The export-error
state is driven by overriding `URL.createObjectURL` via `page.evaluate` at click time.

### Ring-buffer lifecycle

The 60-sample ring is per-component-instance `$state<Record<conn_id, Sample[]>>` —
NOT module-global. Verified: fill → unmount → remount starts at 1 sample, not 61.
Per-`conn_id` rings bound independently: two `conn_id`s fed 99 frames each both cap
at exactly 60.

## FEDERATION PRODUCER PIPELINE [EXISTS]

CeraUI is the **producer** of the version-federation dialog bundles consumed by
`ceralive-platform`'s web dashboard. The full contract lives in root
[`AGENTS.md`](../AGENTS.md) → "Version-federation hosting/signing contract". This
section documents the build, sign, and upload steps that CeraUI owns.

### What gets built

Three Vite lib-mode ES-module bundles — one per config dialog:

| Bundle | Entry point |
|--------|-------------|
| `encoder.js` | `apps/frontend/src/lib/federation/encoder-entry.ts` |
| `audio.js` | `apps/frontend/src/lib/federation/audio-entry.ts` |
| `server.js` | `apps/frontend/src/lib/federation/server-entry.ts` |

Each entry exports `federationAbiVersion = 1` and
`mountDialog(target, { host, config, locale })`. `locale` is ADDITIVE and OPTIONAL,
so the ABI stays 1: a bundle carries its OWN copy of the Paraglide runtime, whose
active locale is a module-level binding the host cannot otherwise reach, so a host
that omits it gets the base locale exactly as before. Each entry also calls
`registerFederationMessages()` (`lib/federation/messages.ts`) at module scope —
the SPA resolves its message catalog from lazily-imported per-namespace chunks, and
a hosted bundle fetched as one module against a signed manifest cannot reach those,
so it registers the catalog statically via `@ceraui/i18n/eager`. The wrapper uses its bundled Svelte
runtime to mount and unmount the dialog, so the host never mounts a component
compiled against a different Svelte runtime. `host` is the typed adapter in
`host-contract.ts`; all three dialogs treat a resolved `{ success: false }` host
write as a visible save failure. Audio and Server retain their device-local RPC
fallback, while Encoder reports asynchronous hosted write refusal through the
same localized failure toast.

### Build step: `bun run build:federation`

Runs Vite in lib mode with a dedicated config
(`apps/frontend/vite.federation.config.ts`). Output lands in:

```
dist/federation/<ceraui-version>/
  encoder.js
  audio.js
  server.js
  <shared chunks>.js
  frontend.css
  federation-build.json
```

The version is read from `package.json` at build time. The output directory is
gitignored and never committed.

### Sign step: `bun run sign:federation`

Runs `scripts/sign-federation.ts`. The Vite build manifest supplies the static
import graph. For every emitted `.js` and `.css` asset:

1. Computes a `sha384-` SRI hash and writes `<file>.sri`.
2. GPG-signs the asset and writes `<file>.sig`.
3. Writes `manifest.json` with every entry, chunk, stylesheet, kind, import edge,
   SRI hash, and CeraUI version.
4. Ed25519-signs the exact manifest bytes as `manifest.json.sig`.

The GPG key is the same CeraLive release key used for `.deb` signing (managed in
`cert-work/`). The Ed25519 key used for PASETO tokens is NOT used here.

### CI publish job: `publish-federation` (in `publish-release.yml`)

Runs in the normal `publish-release.yml` path after the release/package gate
confirms that `package.json` matches the calculated release version and passes
frozen install, lint/typecheck, and unit tests. Releases run only from the
default branch, reject a pre-existing tag/release, and pin and verify
the release tag against the workflow dispatch SHA. The federation job independently
re-verifies the version match before building; for v2026.7.0 it publishes
`ui-bundle/2026.7.0/`. Steps:

1. `bun run build:federation` — produces `dist/federation/<version>/`
2. `bun run sign:federation` — produces `.sri` + `.sig` + `manifest.json`
3. Uploads every signed JS/CSS asset and sidecar plus the signed manifest to R2
   at `ui-bundle/<ceraui-version>/` with pinned content types.
4. `publish-federation-immutable.sh` uses conditional `PutObject` writes and a
   digest of the signed payload set. An identical retry preserves existing
   objects (including earlier valid signature bytes), a changed payload fails
   before any write, and a failed fresh publish removes only objects created by
   that attempt.

`create-release` remains downstream of `publish-federation`, so a public GitHub
release is created only after the complete immutable R2 version is present. If
release creation fails afterward, a same-version retry is idempotent and can
reuse the already-published bytes.

The `apt-worker` serves these files at
`https://apt.ceralive.tv/ui-bundle/<ceraui-version>/<file>`. See
[`../apt-worker/AGENTS.md`](../apt-worker/AGENTS.md) for the serving contract.

### Support window

Bundles are served for 6 months after their release date. Devices running a CeraUI
version older than 6 months receive a read-only gate in the platform dashboard. The
platform checks `ceraui-version` at session start; out-of-window devices get
`{ gated: true, reason: "ceraui_version_unsupported" }` from `/api/device/session`.

### Where to look

| Task | Location |
|------|----------|
| Vite federation build config | `apps/frontend/vite.federation.config.ts` |
| ABI and host adapter | `apps/frontend/src/lib/federation/` |
| Sign + SRI script | `scripts/sign-federation.ts` |
| CI publish workflow | `.github/workflows/publish-release.yml` (`publish-federation` job) |
| Bundle output (gitignored) | `dist/federation/<version>/` |
| ABI harness (mounts the BUILT bundles) | `apps/frontend/tests/federation/federation-abi.test.ts` via `bun run test:federation-abi` |
| Full hosting/signing contract | root `AGENTS.md` → "Version-federation hosting/signing contract" |
| Serving route (apt-worker) | [`../apt-worker/AGENTS.md`](../apt-worker/AGENTS.md) |

## APPLY-NOW CONFIG CHANGE (frontend half) [EXISTS]

Changing resolution/framerate while a stream is LIVE now asks the operator when
to apply it instead of silently deferring. The backend contract (transaction,
`reconfiguring` state, queued stop, staged persistence, marker-only crash
reconciliation) is documented in
[`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → APPLY-NOW CONFIG CHANGE.

- **One predicate drives the badge AND the choice.** `restartChoiceRequired`
  (`lib/streaming/appliesNextStart.ts`) is defined in terms of the existing
  `appliesOnNextStart`, so the `⟳ Applies on next start` badge and the timing
  choice can never disagree. `EncoderDialog` renders the choice as a fieldset
  (`data-testid="encoder-apply-choice"`) pre-selected to `nextStart` — the
  unchanged default, so Save alone never restarts a live broadcast.
- **`apply_now` is a directive, not config.** It rides `buildEncoderSetConfig`'s
  payload but is filtered out of `LiveView`'s pending-field lock, because the
  server never echoes it back.
- **Phases are fenced on `attemptId`.** `reduceConfigChange`
  (`lib/streaming/configChangePhase.ts`) drops a terminal phase that contradicts
  a KNOWN current attempt, but ADOPTS one for an unknown attempt — a client that
  connected mid-transaction never saw `applying`, and swallowing its only outcome
  is the "event fired before anyone was listening" defect class. The `applying`
  banner therefore always clears.
- **Engine reasons are NEVER rendered raw.** `configChangeReport`
  (`lib/streaming/configChangeCopy.ts`) maps the machine-stable reason tokens to
  keyed copy in all 10 locales and falls back to a log pointer, so an unmapped
  token can never leak an ALSA path or unit name to an operator with no console.
  `change_rejected` is one of those tokens: an engine that REFUSES the parameters
  never began the transaction, so it renders as a `reverted` warning naming the
  refusal — never the `rollback_failed` "and the stream stopped" sentence, which
  would describe a healthy live stream as dead. Backend contract:
  [`apps/backend/AGENTS.md`](apps/backend/AGENTS.md) → "THE ENGINE SPEAKS PIXELS".
- **Device-UI reachability caveat:** `EncoderDialog` is mounted above the
  idle/live cockpit switch, but the `open-encoder-dialog` row lives in
  `IdleCockpit` only. So on the device the choice is reachable when the dialog is
  already open as the stream goes live, via the federated platform-dashboard
  mount, or via a direct RPC — `LiveCockpit` has no encoder affordance. Adding
  one is a deliberate UX decision, not part of this contract.

## RECEIVER COHERENCE — v2 destination/transport/latency model [EXISTS]

The Live → Receiver/Server dialog is **destination-as-provider, latency-only**.
Full model: [`docs/RECEIVER_MODEL.md`](docs/RECEIVER_MODEL.md) → "Device UI v2".

- **Destination IS the provider.** `DestinationSection` renders three tiles —
  CeraLive Cloud / BELABOX Cloud / Custom — driven by
  `deriveDestinationChoice(config)` (`receiver-experience.ts`,
  `ReceiverDestinationChoice = 'ceralive' | 'belabox' | 'custom'`,
  `MANAGED_DESTINATION_CHOICES` from `CLOUD_PROVIDERS`). A managed cloud the device
  has no key for shows an add-key prompt (`data-testid="destination-needs-key"`)
  that opens `CloudRemoteDialog` with the `provider` prop preselected. No provider
  dropdown, no manual-endpoint override, no provider-switch stale warning.
- **One transport.** `TransportRow` shows SRTLA active; RIST (`TD-rist-egress`) +
  SRT (`TD-plain-srt-egress`) are calm coming-soon pills. `ProtocolSelector` and
  `TransportBadge` are removed; there is no protocol radiogroup.
- **One knob.** `LatencySection` (replaces `StreamTuningSection`) is a single
  latency slider; window from `deriveLatencyRange(getCapabilities())`. The
  device-side FEC / recovery / presets / cloud-override controls are removed.
- **Schema/handlers kept.** `device.setProfile` + its wiring and the
  `fec_enabled` / `recovery_mode` / `stream_profile` / `profile_decided_by` schema
  fields are intact (the cloud may still push a profile; the device applies latency
  and tolerates the rest). `buildServerSetConfig` is latency-only and clears a stale
  `selected_ingest_endpoint` on every non-slot save (round-3); the backend
  `streaming.setConfig`/`getConfig` persist + echo `selected_ingest_endpoint`.

### Stream Tuning card — SUPERSEDED (historical)

The notes below describe the removed Stream Tuning card (Task 16). The card,
`StreamTuningSection.svelte`, and the device-side tuning derivations are gone; the
`@ceraui/rpc` `stream-profile.schema.ts` exports and the `device.setProfile`
backend path are retained for the cloud control-channel.

The Stream Tuning card was a section inside `ServerDialog.svelte` that exposed per-profile SRT controls gated on receiver capability.

### Schema layer

`packages/rpc/src/schemas/stream-profile.schema.ts` — the single source of truth for all profile-related types:

| Export | Description |
|--------|-------------|
| `streamProfileSchema` | `{presetId, latencyMs, fecEnabled, recoveryMode}` — the wire config |
| `receiverCapsSchema` | `{kind, supportsFec, supportedProfiles, latencyRange, recoveryMode}` |
| `STREAM_PROFILE_PRESETS` | `balanced \| low-latency \| resilient \| classic \| low-latency-fec` |
| `STREAM_PROFILE_IDS` | presets + `'custom'` |
| `STREAM_RECOVERY_MODES` | `reorderfreeze \| srtlapatches \| stock` (internal taxonomy) |
| `streamRecoveryPreferenceSchema` | `standard \| bandwidth-saver` (operator-facing; distinct from internal freeze taxonomy) |
| `DEFAULT_RECOVERY_PREFERENCE` | `'standard'` |
| `RECEIVER_PROFILE_KINDS` | `ceralive \| belabox \| custom \| unknown` |
| `DEFAULT_NON_CERALIVE_PROFILE` | `'classic'` |
| `PRESET_CONFIGS` | `Record<StreamProfilePreset, PresetConfig>` — v1 preset table (latencyMs/fecEnabled/recoveryMode per preset) |

`streaming.schema.ts` carries additive-optional `supported_profiles` / `profile_catalog_version` / `fec_capable` / `latency_range` on `capabilitiesMessageSchema` (consumes cerastream Todo 10 emit; snake_case wire names; backend forwards verbatim).

`streaming.schema.ts` also carries additive-optional `fec_enabled: boolean` + `recovery_mode: streamRecoveryPreferenceSchema` on both `streamingConfigInputSchema` (input) and `configMessageSchema` (echo). These round-trip through `config.json` via `runtimeConfigSchema` + `streaming.procedure.ts`.

### Pure logic (`receiver-experience.ts`)

`apps/frontend/src/lib/streaming/receiver-experience.ts` — pure, rune-free module. New exports added for the Stream Tuning track:

| Export | Description |
|--------|-------------|
| `deriveReceiverProfileKind(provider)` | Maps `config.remote_provider` to `ReceiverProfileKind` (`ceralive \| belabox \| custom \| unknown`). Only a managed CeraLive cloud is the full-controls branch; a custom endpoint is always `'unknown'`. |
| `deriveReceiverCaps(kind, source)` | CeraLive branch trusts the engine snapshot (`supported_profiles`/`fec_capable`/`latency_range`, fallback L1 window `{100,1500,5000}`); every other kind is clamped to the BELABOX-compatible Classic baseline (`{supportsFec:false, ['classic'], {100,1500,2000}, stock}`). |
| `deriveStreamTuningExperience(caps)` | Returns `StreamTuningExperience` — the full gating state for the card (latency range, FEC enabled/disabled-with-reason, recovery mode, preset chips). |
| `getPresetChips(experience)` | Returns `PresetChip[]` in display order `[low-latency, balanced, resilient, low-latency-fec, classic, custom]`. Disabled-with-reason rules: non-CeraLive → all presets carry `presetsDisabledReasonKey`; FEC preset on non-FEC build → `reasonFecUnsupported`; preset not in `availableProfiles` → `REASON_PROFILE_UNSUPPORTED`. |
| `matchActivePreset({latencyMs, fecEnabled, recoveryMode})` | Derives the active `StreamProfileId` from live values — editing any control flips to `'custom'` automatically. |

**CeraUI defines its own `ReceiverProfileKind`** (lowercase `ceralive/belabox/custom/unknown`, aligned with `config.remote_provider` / `RELAY_PROVIDER_KINDS`) — NOT imported from `ceralive-platform`'s `ReceiverKind` (`'CeraLive'` capital). Rule D: repos are self-contained; mirror, don't link.

### UI component

`apps/frontend/src/main/dialogs/server/StreamTuningSection.svelte` — presentational section hosted in `ServerDialog.svelte` after `TransportBadge`. Controls:

- **Latency slider** — continuous range input (step 50, bounds from `experience.latencyRange`); seconds pill ("1.5 s"); labelled "Negotiated" while streaming (reads `config.srt_latency` — the applied/echoed device value).
- **FEC toggle** — bits-ui `Switch` (`<button role=switch>`); disabled-with-reason when `!experience.fecEnabled` (two distinct reasons: `reasonNonCeraLive` for non-CeraLive receivers, `reasonFecUnsupported` for CeraLive receivers on a stock libsrt build).
- **Recovery mode** — `<details>` "Advanced" disclosure (matches `EncoderDialog` precedent) holding a 2-button segmented control (`Standard` / `Bandwidth Saver`). Non-CeraLive receivers show `reasonReceiverManaged`.
- **Preset chips** — chip row from `getPresetChips()`; `selectPreset(id)` calls `onLatencyChange`/`onFecChange`/`onRecoveryChange` (clamped to range); `activeChip = matchActivePreset(...)`. Custom chip is disabled unless it IS the active state.
- **Non-CeraLive badge** — amber status-warning pill + Radio icon (`data-testid="stream-tuning-belabox-badge"`) shown alongside the BELABOX banner when `kind !== 'ceralive'`.

Accessibility: `<section aria-labelledby="stream-tuning-title">`; slider gains `aria-label` + `aria-valuetext` (human seconds); focus-visible rings via `focusRing` const on preset chips + summary + segmented buttons.

The duplicate bottom SRT-latency slider that previously lived in `ServerDialog.svelte` was removed — the card is now the single source of truth for latency.

### Backend wiring

`apps/backend/src/modules/remote-control/set-profile.ts` — `handleSetProfile(payload) -> Promise<SetProfileAck|null>`. Parse → idempotency cache (`Map<commandId, ack>`) → caps-intersect → persist → reconnect-when-streaming → ack. Deps injected (`getCaps`/`readActive`/`persist`/`isStreaming`/`reconnect`) + `configureSetProfile`/`resetSetProfile` test seams.

`apps/backend/src/modules/remote-control/set-profile-wiring.ts` — `wireSetProfile()` binds production deps. Reconnect = `stop → waitUntilIdle(5s bounded poll) → start`; never throws; persist-only fallback on settle timeout.

`apps/backend/src/modules/remote-control/protocol.ts` — `device.setProfile` added to `INTERNAL_COMMANDS` (spread into `COMMAND_REGISTRY` → auto-advertised in `device.hello` `supportedTypes`; opts the device in per the safe-rollout withhold contract).

`apps/backend/src/modules/remote-control/command-router.ts` — `device.setProfile` arm in the INTERNAL-command branch (applies BEFORE the owner gate, like `ingest.slots`). Maps ack → result payload `{ok: status==='applied', applied: ack, error: reason on reject}`.

**Caps intersection (device-side safety net):** `presetId ∉ supported_profiles` (when list present+non-empty, `presetId !== 'custom'`) → REJECT `profile_unsupported`. `fecEnabled && !fec_capable` → REJECT `fec_unsupported`. `latencyMs` clamped to `latency_range[min,max]` → APPLY (reason `latency_clamped`, not a reject). Caps list undefined (no live engine snapshot) → don't gate the preset (can't prove unsupported; trust the platform).

**Reconnect = apply-on-(re)connect.** Persist always; reconnect (`stop → start`) ONLY when `isStreaming()` — latency/profile cannot change live (engine `reload-config` has no latency arm). Idle → persisted config applies on next start.

**Ack transport.** The rich ack `{commandId, status, reason, effectiveActiveProfile, effectiveLatencyMs}` rides the `result` frame's `applied` field (`kind:"result"`, `cid==commandId`). The immediate `delivery.ack` (auto-emitted by the router for every registered command, pre-apply) is the platform's retry-cancel signal.

### WHERE TO LOOK (Stream Tuning)

| Task | Location |
|------|----------|
| Profile + receiver-caps Zod schemas | `packages/rpc/src/schemas/stream-profile.schema.ts` |
| Streaming config schema (fec_enabled, recovery_mode) | `packages/rpc/src/schemas/streaming.schema.ts` |
| Pure receiver-caps + tuning-experience logic | `apps/frontend/src/lib/streaming/receiver-experience.ts` |
| Stream Tuning card component | `apps/frontend/src/main/dialogs/server/StreamTuningSection.svelte` |
| `device.setProfile` handler | `apps/backend/src/modules/remote-control/set-profile.ts` |
| `device.setProfile` production wiring | `apps/backend/src/modules/remote-control/set-profile-wiring.ts` |
| `device.setProfile` in INTERNAL_COMMANDS | `apps/backend/src/modules/remote-control/protocol.ts` |
| `device.setProfile` command-router arm | `apps/backend/src/modules/remote-control/command-router.ts` |
| Runtime config schema (stream_profile, fec_enabled, recovery_mode) | `apps/backend/src/helpers/config-schemas.ts` |
| Tests (handler + routing) | `apps/backend/src/tests/control-set-profile.test.ts` |
| Tests (receiver-experience + StreamTuningSection) | `apps/frontend/src/lib/streaming/receiver-experience.test.ts` + `apps/frontend/src/tests/StreamTuningSection.test.ts` |
| E2E tests | `apps/frontend/tests/e2e/stream-tuning.spec.ts` + `tests/e2e/visual/stream-tuning.visual.spec.ts` |

## RECEIVER CAPABILITY RECONCILIATION

Canonical decision record: [`docs/RECEIVER-RECONCILIATION.md`](https://github.com/CERALIVE/ceralive/blob/master/docs/RECEIVER-RECONCILIATION.md)

**Receiver kind in `device.hello` (Task 12, pending).** Extend `buildDeviceHello` in
`apps/backend/src/modules/remote-control/channel.ts` to carry the device's configured
receiver kind in `deviceCaps.receiverKind`. Derive from config:

- `relay_server` or `selected_ingest_endpoint` present → managed provider
  (`config.remote_provider` ∈ `{ceralive, belabox}`); emit that value.
- `srtla_addr` present (manual custom endpoint) → emit `custom`.
- Neither → omit the field (platform treats absent as `unknown` → baseline).

This is additive/optional on both sides: the platform (`ceralive-platform` Tasks 5/6)
tolerates its absence (defaults to `unknown` → baseline). CeraUI Task 12 and platform
Tasks 5/6 ship independently (R2-safe).

**Important:** derive from the MEDIA DESTINATION, not `config.remote_provider` alone.
A CeraLive-paired (control) device can stream its media to a Custom receiver while
`remote_provider` stays `ceralive`; reporting `ceralive` would wrongly get it pushed
FEC/L1. The derivation logic above handles this correctly.

**QA gate (Task 12):** a CeraLive-paired device with a manual custom endpoint reports
`custom` → platform resolves baseline-only (not FEC/L1). Unset `remote_provider` →
field omitted.

## NETWORK-INGEST GATEWAY (LAN RTMP/SRT) [EXISTS]

Two image-baked LAN ingest gateways (image-building-pipeline `feat/network-ingest-gateway`
branch, Todos 14–15) let a phone or OBS on the same LAN publish directly into cerastream
without going through the cloud relay. CeraUI is the runtime-verification + UI layer; the
gateways themselves are baked into the device image. See image-building-pipeline
`v2/docs/DEFERRED.md` item 7 for the LAN-scoped-in-v1 posture and the on-device QA checklist.

**Baked units (image-building-pipeline, NOT this repo):**
- `ceralive-rtmp-gateway.service` — pinned MediaMTX (`moq: false`), config
  `/etc/mediamtx.yml`, binary `/usr/local/bin/mediamtx`. The publish path is HARDCODED
  (`rtmp://<device>:1935/publish/live`, matches cerastream's `InputKind::RtmpLocalhost`).
- SRT has **two topologies during the B2 fleet transition** (Task 16 makes CeraUI tolerate
  both): **OLD** — a standalone `ceralive-srt-gateway.service` (srt-live-transmit) on :4001;
  **NEW** — the SAME MediaMTX unit terminating SRT too (Task 14), proved by `/etc/mediamtx.yml`
  top-level keys `srt: yes` + `srtAddress: :4001`. The published SRT URL stays `srt://<lan>:4001`
  in BOTH. **No SRT passphrase in v1** — see the DEFERRED.md item 7 follow-up.

**Backend status surface** (`apps/backend/src/modules/network/network-ingest.ts`):
- `getNetworkIngestInfo(): NetworkIngest` — sync read of a cached snapshot probing the
  systemd unit(s) via `systemctl is-active` (`Bun.spawn`, gated on `isRealDevice()`), a
  reused LAN IP (`resolvePrimaryLanIp` — eth/en preferred, cellular/wifi excluded), and
  the board's capability source kinds.
- **FAIL-CLOSED dual-topology SRT probe (Task 16, B2):** SRT is available iff (OLD)
  `ceralive-srt-gateway.service` is active, OR (NEW) `ceralive-rtmp-gateway.service` is
  active AND `parseMediamtxSrtEnabled(/etc/mediamtx.yml)` proves top-level `srt: yes` +
  `srtAddress: :4001` (a targeted line-parse; only column-0 keys count). "rtmp active"
  alone NEVER implies SRT — an old image whose srt unit died must not false-positive; a
  parse failure/absent config → NOT srt-capable. The merge is the pure `resolveSrtTopology`;
  the serving topology is recorded on the additive `srt.gateway: 'mediamtx' |
  'srt-live-transmit'` field.
- Rides the EXISTING `status` broadcast as additive-optional `network_ingest` (NOT a new
  endpoint): `{ rtmp: {service_active, url} | null, srt: {service_active, url, gateway?} | null }`.
  Per-protocol `null` when the board's capabilities exclude that source; `gateway` is set only
  on SRT, only when available. Shape is additive-only — legacy consumers still parse.
- `buildGatewayProbe()` wires the real `GatewayProbe` into
  `apps/backend/src/modules/streaming/gateway-availability.ts` (`setGatewayProbe`) — the
  seam that gates an rtmp/srt stream start, keyed off the merged fail-closed `service_active`.

**Streaming-start gate** (`gateway-availability.ts` + `streaming.procedure.ts`): an rtmp/srt
pipeline carries `requires_gateway: 'rtmp' | 'srt'` on `pipelineSchema` (additive-optional,
present only on those two entries). `streamingStartProcedure` blocks the start and returns
`{success:false, error: GATEWAY_INACTIVE_ERROR}` when `isGatewayActive(kind)` is false. The
default probe is FAIL-SAFE (`isActive: () => false`) until `setGatewayProbe()` runs at boot —
rtmp/srt starts are blocked-by-default, never silently pass the gate. rtmp/srt stay VISIBLE
in the pipeline registry at all times (disabled-with-reason house rule) — never filtered out.

**Frontend card** (`apps/frontend/src/lib/components/custom/NetworkIngestSection.svelte`,
mounted in `LiveView.svelte` directly after `SourceSection`): shows each protocol's LAN
publish URL (copy button + QR via `generateDeviceAccessQr`), selects the matching pipeline
via `config.pipeline` through the standard field-sync lock, and disables-with-reason when
the service is inactive or the stream is already running. Renders nothing when
`status.network_ingest` is null/absent or both protocols are null.

**Single gateway-availability truth (Todo 19):**
`apps/frontend/src/lib/streaming/pipelineAvailability.ts` (pure, rune-free) is the ONE
shared rule every frontend surface routes through — `pipelineAvailability(pipeline,
networkIngest)` returns `{available:true}` or `{available:false, reason}` (i18n key
`live.education.reason.gatewayInactive`). Routed surfaces: `EncoderDialog.svelte` (source
list + Save gate), `lib/streaming/modePresets.ts` (`presetViews`), `ValidationAdapter.ts`
(re-export, single import surface), `StreamingConfigService.ts` (`buildStreamingConfig`
guard). FAIL-SAFE: a null/absent `network_ingest` (older backend, or the snapshot hasn't
arrived yet) blocks the pipeline — never silently permits it. Do NOT re-derive this rule
inline anywhere else.

## NETWORK COLLISION SURFACING + POLICY-ROUTE SELF-CHECK [EXISTS]

Two informational/warning netif signals surface interface-topology issues WITHOUT ever
gating a stream or an interface — both ride the existing 5 s `netif` broadcast.

**`same_subnet_group`** (additive-optional `string`,
`packages/rpc/src/schemas/network.schema.ts` `netifEntrySchema`): the CIDR (e.g.
`"192.168.0.0/24"`) shared by two-or-more DIFFERENT-IP interfaces on the SAME subnet
(computed synchronously in `apps/backend/src/modules/network/network-interfaces.ts`
`netIfBuildMsg()`). This is NOT an error — bonded links commonly share a subnet via policy
routing. The AP/hotspot interface is excluded via the existing `dupIpSuppressedIfaces`
transition marker + `NETIF_ERR_HOTSPOT` confirmed-state marker (no new hotspot-detection
code). Distinct from — and computed AFTER, so excluded from — the existing dup-IP detection
(`NETIF_ERR_DUPIPV4`).

**`policy_route_missing`** (additive-optional `boolean`, same schema, **TRISTATE**):
flags a bonded wifi/modem interface (`/^(?:wlan|usb|ww)/`) whose `ip rule`/
`ip route` tables are missing a default route — the policy-routing self-check
(`apps/backend/src/modules/network/policy-route-check.ts`) found the interface is
enabled + IP-bearing but its source-routing table has no default route. Computed via an
async `ip rule show` / `ip route show table <t>` spawn (`isRealDevice()`-gated, degrades
to `null` on any parse/spawn failure), cached and polled on the netif interval, attached
synchronously in `netIfBuildMsg()` via a `Set<string>` cache
(`refreshPolicyRouteFlags`/`getPolicyRouteVerdict`) — mirror this cache+poll+sync-getter
split for any future async-derived netif flag; a purely-sync-derivable flag should instead
compute in place like `same_subnet_group`. Table numbers are NEVER hardcoded — derived
from `ip rule show` / `ip route show`, matching image-building-pipeline's
`dispatcher.d/90-srtla-wifi-routing` convention.

**This field is emitted as an explicit `false`, NOT omitted, whenever the check
completed.** It is present-only-when-true's counter-example, and the asymmetry is
load-bearing: the frontend netif merge deliberately PRESERVES an omitted optional
field (`subscriptions.svelte.ts`), so a flag that is only ever published as `true`
can be raised but never retracted. That latched the amber band in a live operator's
session — `wlan0` was flagged while it was a bonded station, then switched to
AP/hotspot mode, which correctly drops it from the bond (`setNetifHotspot` →
`enabled: false`) and correctly stops it being a check candidate; the backend went
quiet and the band stayed up with `ip rule list` carrying nothing but the three
kernel defaults. `getPolicyRouteVerdict()` returns the tristate — `true`/`false` are
both authoritative, `undefined` only for an indeterminate check — and absence is
reserved for "no verdict this tick". Do NOT collapse `undefined` into `false`, and
do NOT re-narrow the emitter to true-only. Any FUTURE additive netif flag that can
RECOVER needs the same treatment; `same_subnet_group` shares the latent latch (it is
a calm info band, so it was left alone deliberately).

**Frontend surfacing** (`apps/frontend/src/main/network/CollisionBands.svelte`, mounted in
`NetworkView.svelte` right after `BondedLinksSection`): a CALM info band
(`bg-status-info/10`, `data-testid="same-subnet-info"`) lists the shared CIDR(s); an AMBER
warning band (`bg-status-warning/10`, `data-testid="policy-route-warning"`) fires when any
interface carries `policy_route_missing`. Both are static/CSS-only (e-ink-freeze safe).
i18n: `network.collision.*` (10 locales). **NEVER gate an interface or a stream on either
signal** — both are informational/warning only.

## AUTH-STATE + CONNECTION STORE CONSOLIDATION [EXISTS]

`apps/frontend/src/lib/stores/websocket-store.svelte.ts` (528 LOC, the legacy monolithic
`getAuth`/`getStatus`/`sendAuthMessage`/`socket`/etc. wrapper) is FULLY DELETED. Its
consumers were migrated across a 4-step sequence (Wave 2) to the two stores that now
exclusively own connection and auth-mutation state:

**`apps/frontend/src/lib/rpc/subscriptions.svelte.ts`** — the SOLE `rpcClient.onMessage`
consumer (`initSubscriptions()`, called once from `main.ts`). Owns every non-auth reactive
getter (`getConfig`, `getStatus`, `getModems`, `getWifi`, `getIsStreaming`, `getNetif`, …)
plus connection-state getters (`getIsConnected`, `getConnectionState` — survive socket
replacement on reconnect; prefer these over `offline-state.svelte` in any authed
component).

**`apps/frontend/src/lib/stores/auth-status.svelte.ts`** — the SOLE auth-mutation path:

```ts
export function ingestAuth(message: LoginOutput | undefined): void;   // THE writer
export function getAuthMessage(): LoginOutput | undefined;             // THE reader
export async function authenticate(password: string, persistentToken: boolean): Promise<void>;
export async function createPassword(password: string): Promise<void>;
export const authStatusStore: { value: boolean; set(b): void; subscribe(cb) };
```

`Layout.svelte`/`Auth.svelte` call `authenticate`/`createPassword`/`getAuthMessage` —
never `sendAuthMessage`/`sendCreatePasswordMessage`/`getAuth` (those no longer exist).

**The rule for all future frontend work:** ONLY `subscriptions.svelte.ts` (non-auth
reactive state + connection state) and `auth-status.svelte.ts` (auth mutation state) own
connection/auth state. Do not add a second `rpcClient.onMessage` owner or a parallel
auth-mutation path. A CI grep gate
(`apps/frontend/src/tests/deprecated-ws-store-gate.test.ts`) fails the build if the literal
`websocket-store` module name reappears anywhere in `apps/frontend/src` — re-introducing a
legacy WS bridge is therefore a deliberate, visible decision, never a silent import.

**`offline-state.svelte.ts` / `pwa-status.svelte` read connection state from `$lib/rpc/client`
directly** (`rpcClient.getConnectionState()` + `onConnectionChange`) — NOT from
`subscriptions.svelte` — to stay pre-auth-pure (no subscription graph pulled before login).
This is the one deliberate exception to "read connection state from subscriptions.svelte",
not drift. `offline-state.svelte.ts` additionally imports `connection-ux.svelte.ts` for the
ONE shared reconnect-grace verdict (`getDisconnectedSince` / `getHasConnected` /
`getGraceNow` / `hasOutlastedBannerGrace`); that store reads the same client surface
directly, so the pre-auth purity is preserved and the full-page offline takeover can no
longer disagree with the smaller banners about how long a drop has lasted. Do NOT give
`offline-state` a second offline detector or a second grace constant — see
[`apps/frontend/AGENTS.md`](apps/frontend/AGENTS.md) → "Reconnect-surface grace period".

## CAPABILITY-TRUTHFULNESS REGRESSION GATE [EXISTS]

`apps/frontend/tests/e2e/truthfulness.spec.ts` is the capstone rendered-DOM proof that the
UI never lies about a capability. It injects three capability snapshots (full /
engine-starting / engine-unavailable) over the page WebSocket against ONE mock backend
(`MOCK_SCENARIO=multi-modem-wifi`, fixed per worker) using the same `routeWebSocket` proxy
pattern as `source-overhaul.spec.ts`, and asserts three things:

1. **Real DOM flips**, not just internal state — the H.265 codec button, the latency-slider
   `aria-valuemin`/`aria-valuemax`, the audio live-switch control, the capability-tier
   banner, and the `network-ingest-select-rtmp` row all genuinely enable/disable/change
   bounds across the three snapshots (RIST/SRT transport pills are asserted honest
   coming-soon — `role="note"`, never fake-interactive — since they never flip).
2. **No orphan `data-debt-id`** — every rendered `[data-debt-id]` (from `ComingSoon.svelte`)
   is cross-checked against the `open` entries in `docs/TECHNICAL_DEBT.md`, reusing the SAME
   parser (`DEBT_ID_RE`) as `scripts/check-tech-debt.mjs`.
3. **No undefined-RPC crash** on a full dialog click-walk (encoder/audio/server open+close,
   destination navigation) — `page.on('pageerror')` plus filtered console-error assertions.

This is the terminal regression gate for every truthfulness contract landed across this
plan (gateway-availability, capability-vs-active split, disabled-with-reason everywhere) —
extend it, don't duplicate it, when a new capability-gated control ships.

## DEVICE-FIRST SOURCE MODEL + GO LIVE CARD [EXISTS]

The Live destination was rebuilt (experience-simplification plan, Tasks 1-20)
around ONE device-first source list and ONE adaptive Go-Live surface, replacing a
scattered pipeline picker + device list + onboarding checklist + server-readiness
card + stream-settings card.

### `config.source` + the unified `sources` broadcast

`apps/backend/src/modules/streaming/sources.ts` is the single builder. It folds
the coarse pipeline registry, the engine's `list-devices` result, and the
network-ingest gateway status into ONE ordered `StreamSource[]` list
(`getSourcesMessage()` = `{hardware, sources}`, broadcast as `sources` — rides the
existing bus, no new endpoint). Every row is one of four `origin` variants
(`capture`/`coarse`/`virtual`/`network`), each carrying its own `modes`
(per-device Tier-2 caps when known), `audioKind`, and availability —
`packages/rpc/src/schemas/sources.schema.ts` is the schema source of truth
(`StreamSource`, `sourcesMessageSchema`).

- **`config.source`** persists the operator's pick as a single id (an `input_id`
  for capture, a pipeline id for coarse/virtual, `rtmp`/`srt` for network).
  Legacy configs (no `source` field) are coerced once at load
  (`coerceLegacySource`, `apps/backend/src/helpers/config-schemas.ts`) from
  whatever combination of `selected_video_input`/`pipeline` they already have —
  idempotent, never throws, logs once.
- **`deriveEngineRouting(sourceId, sources)`** (`sources.ts`) resolves a source id
  to the wire pair the engine needs: `{pipeline, selected_video_input}`. A
  capture id routes to its bridged pipeline + its own `input_id`;
  coarse/virtual/network route to their pipeline id with `selected_video_input`
  explicitly `undefined` (clearing a stale capture selection — the engine's
  existing `config.selected_video_input ?? getActiveInput()` fallback fills it).
  `resolveSourceRouting()` wraps this with the `unknown_source` rejection and is
  the seam both `streaming.setConfig` and `streaming.start` call BEFORE any
  config mutation or engine dispatch — `cerastream-backend.ts` is untouched by
  this entire model (verified by a `git diff`-based regression test).
- **Shim policy**: the legacy `pipelines`/`devices` broadcasts and the coarse
  `capabilities.device_modes` field are kept running unmodified as a rollback
  safety net. `EncoderDialog.svelte`, `AudioDialog.svelte`, `LiveView.svelte`,
  and `StreamingStateManager.svelte.ts` have migrated off the legacy getters and
  now use `getSources()`-derived data. The legacy getter definitions and
  compatibility/comment references remain, but there are no direct consumer
  call sites in these four files. The producers stay in place for the rollback
  net; the real exit condition is ship one release with no rollback needed,
  THEN delete the producers. Tracked as
  `TD-legacy-source-broadcasts` in `docs/TECHNICAL_DEBT.md`; do not delete the
  producers until that entry's exit condition is met.

### StreamSetupChain / IdleCockpit / LiveCockpit

`apps/frontend/src/main/live/` now holds the Live destination's cockpit split.
**`GoLiveCard.svelte` no longer mounts anywhere** — a subsequent
live-experience-refinement pass merged its gates + config rows into
`StreamSetupChain.svelte`, which is the component actually rendered today (see
`docs/TECHNICAL_DEBT.md` → `TD-unmounted-source-shims` for the up-to-date shim
list, which already reflects this):

- **`StreamSetupChain.svelte`** — ONE "Stream setup" card of THREE
  always-visible rows in signal order (Encoder → Destination → Network) — no
  collapse state, no thin ready-bar; every row is rendered at all times. It is a
  presentation-only remap of the pure `deriveGoLiveReadiness()`
  (`apps/frontend/src/lib/streaming/go-live-readiness.ts`, four gates:
  source/network/destination/engine) — the verdict is consumed byte-unchanged and
  never re-derived here. Each row fuses a readiness-state dot with the migrated
  config-row summary/edit affordance (same testids/lock semantics as the retired
  `StreamSettingsCard`); the Destination row also carries the traffic-light chip
  (fed by the destination-validation store, below) and the Encoder row a
  bitrate-ceiling chip. Audio is deliberately NOT a row (live-correctness-pass
  Todo #11 — see "LIVE-CORRECTNESS-PASS FIXES" below); the ENGINE gate is also not
  a row (owned by the `CapabilityTierBanner` + the Start button's disabled
  reason). It detects a sole-camera device with no `config.source` set and folds
  the implicit id into the Start payload WITHOUT writing config — the row only
  shows a "Change" affordance. It owns NO RPC and writes NO config itself; every
  action is a callback prop from `LiveView`.
- **`IdleCockpit.svelte`** — pre-stream wrapper, source-first order:
  `SourceSection` → `StreamSetupChain` (readiness rows + Start, mounted exactly
  once) → a collapsed Preview `<details>` disclosure → a collapsed Roadmap
  `<details>` disclosure (the relocated `TD-pip`/`TD-mode-fallback`/
  `TD-embedded-audio` "coming soon" pills). Pure prop pass-through — no `$state`,
  no RPC.
- **`LiveCockpit.svelte`** — streaming wrapper: telemetry strip → bitrate
  adjuster (the sole bitrate-hot-adjust owner while live) → `IngestStats` → Stop.
- **`LiveView.svelte`** switches between the two on the OPTIMISTIC streaming edge
  (`isStreaming || streamingOptimismState === 'starting'`) — never on the raw
  `is_streaming` flag alone, so Start never flickers back to idle mid-launch.
- **`SourceSection.svelte`** (`lib/components/custom/`) renders the single
  `getSources()` list as one `<ul>` (every origin as a row; broadcast order — the
  Todo #10 reorder UI is removed, see below) filtered to `visibleSources` (an
  operator-disabled network row hides UNLESS it is the currently-selected
  source). It owns the `config.source` write itself
  (`rpc.streaming.setConfig({source})`) and is the sole audio-configuration
  surface (Todo #11) — it is no longer a purely presentational component.

### Deprecation shims kept-but-unmounted (registered, not deleted)

`StreamSettingsCard.svelte`, `OnboardingChecklist.svelte`, `ServerReadiness.svelte`
(all `main/live/`), `GoLiveCard.svelte` (`main/live/`), and
`NetworkIngestSection.svelte` (`lib/components/custom/`) are no longer mounted
anywhere — `StreamSetupChain`/`IdleCockpit`/`SourceSection` absorbed every
responsibility they used to own in `LiveView`. The files are kept (not deleted) as
a one-release rollback safety net; only `StreamSettingsCard`'s `ConfigRow` type is
still imported (now by `StreamSetupChain`/`IdleCockpit`). Tracked as
`TD-unmounted-source-shims` in `docs/TECHNICAL_DEBT.md` — do not delete these
files until that entry's exit condition is met, and do not re-mount them either.

### Engine-truth-clears-on-stop contract

`getStatus()?.active_encode` obeys the same never-stale-past-stop rule as the
link telemetry below. It is stronger than a cosmetic staleness issue:
`deriveActiveSummary` reads `live = Boolean(activeEncode)` and then prefers
`activeEncode.active_input` over the fresh `config.source`, so a retained object
claims the device is LIVE on a device that has stopped — observed on a board as
a stopped session still labelled `"● Live RØDE HDMI to USB-C … H.265"` after the
operator had already picked a different source. Guaranteed on both ends:
`cerastream-backend.ts` drops `active_encode` from telemetry when the engine
reports it is not streaming AND on `stop()` (a crashed engine sends no final idle
frame), and every status nudge now carries the field explicitly rather than only
when it exists; `subscriptions.svelte.ts` additionally clears it on the
`wasStreaming && !isStreamingState` edge, because the status merge preserves an
omitted field — the same raise-but-never-retract latch that bit
`policy_route_missing`.

### Telemetry-clears-on-stop contract

`getLinkTelemetry()` is guaranteed `null` (never a stale object) on the
streaming→stopped transition edge — belt-and-braces on both ends: the backend's
5 s heartbeat emits exactly one `{linkTelemetry: null}` frame after
`stopLinkTelemetry()` clears the source state (dedupe cache is deliberately NOT
reset in the stop path, so the null frame broadcasts once, not forever), and the
frontend additionally clears `linkTelemetryState` on the `wasStreaming &&
!isStreamingState` edge as a second guarantee even if a stop frame omits the
field. The tri-state distinction is load-bearing: `undefined` = pre-first-status
(skeleton), `null` = delivered-empty/stopped (dashes), object = live values. HUD
bitrate (`bitrateKbps: isStreaming ? config?.max_br ?? null : null`) and
per-interface throughput (`buildLinks(..., isStreaming)`) follow the same
never-stale-past-stop rule.

### HUD 4-fact scope

The persistent HUD strip (`HudBar.svelte`) surfaces exactly FOUR facts at a
glance: the lifecycle/state badge (live/idle/offline), the health verdict dot,
the bitrate, and ONE temperature chip. Voltage/current, per-link RTT/NAK/weight,
and the bond constellation live ONLY in the expanded Sheet — adding a fifth
compact-strip fact is a deliberate UX regression, not a tweak.

### BondedLinks-owns-telemetry rule

`apps/frontend/src/main/network/BondedLinksSection.svelte` is the documented SOLE
owner of live per-link telemetry (RTT/NAK/weight) on the Network destination. The
per-interface WiFi/Cellular/Ethernet section rows do NOT render their own
signal-%/speed-Badge telemetry clusters — that would duplicate numbers already
shown once, correctly, in `BondedLinksSection`. Do not re-add per-link numbers to
the per-interface sections.

## LIVE-CORRECTNESS-PASS FIXES [EXISTS]

A follow-up pass (`live-correctness-pass` plan) tightened the Live destination and
a few surrounding surfaces after the device-first source model shipped. The
sections below are the durable implementation record.

**Truthful device-max pair (Todo #2/#3).** `axisCeiling({offered, deviceModes})`
(`ValidationAdapter.ts`) now returns the ACHIEVABLE resolution×framerate pair when
Tier-2 `deviceModes` are present — intersecting the top rung's own modes with the
offered framerates — instead of the old independent-axes max (which could claim a
fictional pairing, e.g. 1080p/60 when 60fps only actually exists at 720p). One
implementation, two consumers: EncoderDialog's `axis-device-max` chip and
SourceSection's "SOURCE MAX" capability chip both read this same ceiling.
`framerateAvailableAt(axes, fps, excludeResolution)` drives the per-option
"available at Nx" hint on a disabled framerate option, keyed on the candidate fps
(never the resolution — a resolution-keyed hint would falsely stamp the same hint
onto every disabled rate at that resolution). The modes-absent (coarse) branch is
byte-identical to the pre-fix behavior (golden test).

**Destination traffic-light validation (Todo #5).**
`apps/frontend/src/lib/streaming/destination-validation.svelte.ts` is a
session-only (never persisted to `config.json`) rune store that fingerprints the
destination-defining config keys (`ENDPOINT_FINGERPRINT_KEYS`: `relay_server`,
`relay_account`, `relay_streamid_override`, `relay_protocol`, `srtla_addr`,
`srtla_port`, `srt_streamid`, `selected_ingest_endpoint` — `srt_latency` is
excluded, tuning-only) plus the resolved endpoint address, and records the last
`relay.validate` verdict against that fingerprint. `LiveView.validateSavedDestination()`
orchestrates it via `ServerDialog`'s OPTIONAL `onSaved?` callback (fired
fire-and-forget after a successful save — the dialog's mount contract and
federation bundle are unaffected). `StreamSetupChain`'s destination row reads
`getDestinationValidated()` for its traffic-light chip; any endpoint-key edit (or
a catalog-side addr/port drift under the same `relay_server` id) invalidates the
green light. The traffic light is purely informational — it never gates Start.

**Network-ingest operator enable/disable (Todo #6–9).** A new enable/disable layer
on top of the always-on gateway probe described in "NETWORK-INGEST GATEWAY" above:
- Backend: `apps/backend/src/modules/network/network-ingest-control.ts` —
  `readIngestDesired`/`persistIngestDesired`/`setIngestEnabled`/
  `reconcileIngestDesiredState` (fire-and-forget, self-serialising boot reconcile,
  never throws) + `planIngestUnitActions` (pure resolver, topology-aware: the NEW
  shared `ceralive-rtmp-gateway.service` topology stops a unit only when BOTH
  protocols are off and starts it when EITHER is on; the OLD `srtUnitPresent`
  topology keeps rtmp↔rtmp / `ceralive-srt-gateway.service`↔srt independent).
  `rpc.network.setIngestEnabled({protocol, enabled})` persists FIRST, then
  systemctl-applies (isActive-gated — a no-op re-run issues zero spawns), then
  re-broadcasts BOTH `status` and `sources`.
- `status.network_ingest.{rtmp,srt}.operator_disabled?: boolean` — additive,
  present only when `true`, DISTINCT from `service_active` (in the NEW topology a
  shared unit can stay `service_active:true` while a sibling protocol is
  `operator_disabled:true`).
- **The fail-visible three-mirror predicate** — "start-eligible = unit-active AND
  NOT operator-disabled" — is enforced identically in three places that MUST
  agree: the backend gateway probe (`network-ingest.ts` `buildGatewayProbe()`),
  the mock gate (`isMockGatewayActive()`, for dev/CI parity with the real probe),
  and the frontend `pipelineAvailability()` (operator intent checked FIRST, ahead
  of `service_active`/url-null/inactive, reason
  `live.education.reason.disabledInSettings`).
- Frontend: `apps/frontend/src/main/dialogs/NetworkIngestDialog.svelte` (Settings
  → "Network ingest" entry) toggles each protocol via a pessimistic bits-ui
  `Switch` composed with `osCommand` WITHOUT `confirmOnResolve` — the toggle
  position only moves once the confirming `status.network_ingest` broadcast
  lands; the spinner is the sole optimistic element. An emulated-mode refusal
  (`NETWORK_INGEST_UNAVAILABLE_ERROR`) renders a calm inline band instead of a
  toast. `SourceSection.svelte`'s `visibleSources` filter hides an
  operator-disabled network row UNLESS it is the currently-selected source
  (`config?.source === source.id`) — a selected-but-disabled row stays visible,
  disabled, with a reason line AND a Settings-hint line, so the operator can
  always see why their active source stopped working.

**Single audio surface (Todo #11).** The Source card (`SourceSection.svelte`) is
now the ONLY place that surfaces audio configuration. The `open-audio-dialog`
testid moved from the old Stream-setup audio row into SourceSection's audio block
(a "Codec & delay" ghost button, hidden while streaming — the audio surface stays
read-only mid-stream, same lock semantics as before). `StreamSetupChain` no
longer has an audio row (three rows only: Encoder/Destination/Network).

**One transport token per idle surface (Todo #12).** The idle Encoder-row summary
and SourceSection's active-config line no longer separately push a
`SRTLA`/`SRT`/`RIST` transport token — the ONE place the transport still shows
idle is the destination kind badge (e.g. "SRTLA · Bonded", via
`buildServerSummary` → `kindBadgeLabelKey`). The Encoder row instead names the
actual active source (capture device display name, or the pipeline name /
`reconfigureRequired` fallback for coarse/virtual/network sources). The LIVE
`LiveSummaryStrip` transport value is untouched — `deriveActiveSummary`
(`sourceSummary.ts`) still returns `transport` for the live strip; this is an
idle-only render-site fix, never a change to that shared derivation.

**Selected-row-only publish instructions (Todo #13).** A network-ingest row's QR
/ URL / copy / codec-education `<details>` disclosure now renders ONLY when that
row IS the selected source (`config?.source === source.id`); an
unselected-but-enabled network row still shows its select control, status line,
audio-kind pill, and info popover — just not the publish instructions. The QR
effect is narrowed the same way, so no QR is generated for an unselected row.

**Clear-saved-sign-in escape hatch (Todo #19).** `Layout.svelte`'s pre-auth
`authTimedOut` band ("Couldn't verify your session…") gained a second button
(`data-testid="clear-saved-session"`, i18n `connection.clearSavedSession`) beside
Retry. It clears the saved credential (`localStorage.removeItem('auth')` — the
same key `subscriptions.svelte.ts` reads for session restore) and falls through
to the password screen — breaking the retry loop a stale/dead saved token would
otherwise trap the operator in. Retry's own behavior is unchanged.

**Network mutation feedback completeness (Todo #20).** `NetifDialog.save()` and
`BondToggle.toggle()` deliberately share ONE `osCommand` resource key
(`` `netif:${name}` `` — never split into a separate key) so the two surfaces
refuse each other's concurrent mutation as a cross-surface race guard.
`osCommand` (`async-operation.svelte.ts`) gained a `silent?: boolean` option —
suppresses the failure toast but still transitions the op to `failed`, so a calm
inline band can still render off the phase — used by `WifiSelectorDialog`'s
periodic background rescan (`{ silent: true, confirmOnResolve: true }`). New
i18n key: `network.os.saved` (NetifDialog success toast; `deviceBusy`/
`operationFailed` pre-existed).

**Audio-naming tier-3 diagnostic (Todo #21).** The 3-tier audio-naming resolution
(engine `display_name` join on `alsa_card_id` → `/proc/asound/cards` longname →
`audioSrcAliases` generic alias) was already correct — Task 21 added
DIAGNOSTICS ONLY, no resolver rewrite. `audio-naming.ts` gained ONE `logger.info`
call (a deliberate, documented exception to the module's "pure, no side effects"
header) that logs `engineEntriesWithoutJoinKey` whenever a card falls through to
the generic `usbaudio*` tier-3 alias — the single most useful field for
root-causing an on-device "generic USB audio for a named device" report (almost
always a dropped `alsa_card_id` join key upstream of CeraUI). One-shot per
`cardId` per boot (`resetAudioNamingDiagnostics()` wired into `resetMockState()`
for test isolation).

**Audio-device naming cleanup + External marker (device-quality-wave2).** The
ladder above is now **4-tier** — a STATIC, code-level onboard display-name rule is
tier 0 — and tiers 1/2 are CLEANED before display. Both tiers carry raw ALSA
longnames (cerastream sets an audio entry's `display_name` to the longname
verbatim), so a live report showed `RØDE RØDE HDMI to USB-C at
usb-xhci-hcd.17.auto-1, super speed` (leaked via tier 1, because the engine
`product_name` was the generic `"usbaudio"` the human-name heuristic rejects) and
`DJI Technology Co., Ltd. DJI MIC MINI at usb-fc8c0000.usb-1, full speed` (tier 2,
no engine entry). `cleanAudioDeviceName()` strips the kernel `at <bus-path>,
<speed> speed` tail and collapses a manufacturer duplicated as the product prefix
(generic rule, no vendor allowlist — a non-filler token between the repeats blocks
the collapse). An onboard card whose only hardware string is a raw driver id
(`rockchip,hdmiin`) has nothing to clean, so `ONBOARD_AUDIO_DISPLAY_RULES` gives
it a fixed name (`HDMI Input`) — a RULE that ships with the app, keyed on the
driver/card id. The raw string is MOVED, not deleted: it rides
`AudioSource.detail` as a tooltip.

**The VIDEO half of that port gets the same rule.** cerastream reports the RK3588
HDMI-RX capture node's `display_name` as the raw driver id `rk_hdmirx`, which
surfaced verbatim in the Live source row AND the "Configured" summary line once
cerastream PR #69/#70 made the node a real selectable row.
`ONBOARD_VIDEO_DISPLAY_RULES` (`apps/backend/src/modules/streaming/onboard-display-names.ts`)
names it `HDMI Input` — the SAME name as the audio half, since both are one
physical port — and shares the audio rule's `normalizeOnboardKey` folding. The row
and the "Configured" label are NOT separate code paths: both read
`StreamSource.displayName` off the one `sources` broadcast, so the rule is applied
once at `fromEngineDevice()` (plus the v4l2 fallback scan and pre-rule persisted
snapshots) and never at a render site. Display-only — `input_id`/`device_path`/
`stable_id` and the kind heuristic are untouched. Full contract:
`apps/backend/AGENTS.md` → ONBOARD VIDEO DISPLAY NAMES.

**And that port's signal is re-checked, not read once.** The `signal` verdict
(`present`/`absent`/`unknown`, PR #216) was only ever recomputed when the device
SET changed — but an HDMI receiver that reports "no link" while its link
retrains and locks seconds later never changes the set, so the retraining answer
latched. Confirmed live on a Rock 5B+: `dmesg` logged `signal lock ok` +
`New format: 1920x1080p59.94` at 04:29 and the engine's `list-devices` reported
that mode correctly, while the UI still read "No signal" 45 minutes later —
nothing had asked the engine again. The device registry now fires a
`VIDEO_SIGNAL_RECHECK_INTERVAL_MS` (5 s) `onSignalRecheck` tick into
`recheckSourceSignals()`, which re-probes and broadcasts ONLY on change. It is
device-agnostic by construction — no driver or controller string anywhere in the
path, just the caps the engine's own `VIDIOC_QUERY_DV_TIMINGS` result projected.
Full contract: `apps/backend/AGENTS.md` → "A SIGNAL change is invisible to every
hotplug detector".

**A real audio device is never silently absent from the picker.** The card list is
CeraUI's own `/sys/class/sound` scan, and it reads `setup.sound_device_dir` — a
static value packaged into the separately-versioned `ceralive-device` `.deb`. A
value naming any other layout yields ZERO cards, so `audio_sources` collapses to
its two pipeline pseudo-sources and looks exactly like a board with no sound
hardware. Board-confirmed on a Rock 5B+ whose packaged `setup.json` still carried
the pre-#166 `"sound_device_dir": "/dev/snd"`: that directory holds ALSA's device
NODES and no `cardN` directory at all, so a connected, capture-ready RØDE
HDMI-to-USB-C was missing from the picker entirely while the ENGINE had been
reporting it correctly the whole time. `resolveConfiguredAlsaCards` reconciles the
configured directory against the kernel's own on positive evidence only, and
`isPlaybackOnlyCard` drops a card the kernel proves is an OUTPUT structurally
rather than by card id (`rockchiphdmi0` and `hdmi0` are the same block under two
vocabularies). Full contract: `apps/backend/AGENTS.md` → "…AND NEITHER IS A LIVE
AUDIO CARD".

**The idle level meter follows the picker.** Selecting an audio source used to change
nothing about the meter: cerastream chose its own idle card, so an operator who picked
the RØDE could watch the meter report the DJI Mic Mini — or "Meter unavailable" — with
no way to correct it. `config.asrc` is now resolved by `resolveMeterPreference()` and
pushed to the engine as `reload-config` `audio.meter_device` over the always-idle
`audio-meter-bridge` connection (schema ≥ 0.9.0; an older engine is sent nothing and
keeps auto-picking). It is a PREFERENCE, not a pin — cerastream still demotes a selected
card that delivers no samples, so a powered-off receiver can never leave the meter dead.

**"Auto" is resolved, NOT handed back.** It used to send an explicit `null` ("engine, you
choose"), which was right while `"Auto"` meant that and wrong the moment `resolveAutoAsrc`
made it deterministic. `resolveEffectiveAudioPick()` now maps the sentinel through the SAME
rule the start path uses, so the meter prefers the card a launch would actually open. The
old shortcut was doubly invisible: `null` made the engine auto-pick AND disarmed the
foreign-card gate, so on a Rock 5B+ the HDMI source with `"Audio source: Auto"` drew the
RØDE USB card's real, moving bars — for an HDMI audio half with NO capture PCM, i.e. for a
pick whose own start fails `audio-device-unavailable`. Because the resolved card depends on
the selected VIDEO source and on the engine's audio list, a `source` change and an
engine-list change re-push the preference too. Full contract:
`apps/backend/AGENTS.md` → IDLE AUDIO-METER DEVICE PREFERENCE.

**A feed that STOPS recovers itself.** The bridge's original recovery path watched frame
CONTENT (a sustained foreign-card run), so it could only run while frames arrived — and
the meter's worst failure is that they stop. Confirmed live: the engine's level feed went
silent 2 ms after a changed pick published its `handoff` gap, and the meter read a bare
`Meter unavailable` (no reason suffix — nothing was reaching the browser) for 14 minutes
with no operator action. A frame-ABSENCE watchdog now sits beside the content one and
re-asserts the preference through the SAME `null` escape hatch on the SAME once-per-30 s
floor. Full contract: `apps/backend/AGENTS.md` → "THE RECOVERY PATH MUST NOT BE GATED ON
THE SIGNAL WHOSE ABSENCE IS THE FAILURE".

**A momentary "No audio device" during a NORMAL libuvc rebind is a derived-state
artifact, and it is now absorbed.** Opening a UVC-H.264 camera detaches `uvcvideo`
from its USB interfaces (see LIBUVC-HELD DEVICES) — necessary, and no USB device
reset is involved: measured on a board, `devnum` never changes and the camera's ALSA
card and PCM node inode survive untouched. But on RELEASE the engine drops its held
record ≈400 ms (up to 2 s) before it rediscovers the re-registered node, and "Auto"
resolves audio by looking the VIDEO source up first. For that window the join key was
gone, Auto answered `no-same-device-audio`, and the meter read "Meter unavailable ·
No audio device" for a microphone that never moved. `resolveAutoAsrcFromLiveState()`
now resolves the selection through a strictly-bounded absence grace
(`capture-presence.ts`, 2 000 ms, keyed on stable identity) — a hysteresis on the
VERDICT only. Nothing else changes: the `sources` payload, the `lost` row and routing
are untouched, and a sustained absence still reports honestly. In the same window the
`hdmi_error` no-signal RAISE is now scoped like its retraction, so a stream-start's
incidental `/dev/video0` probe no longer shows HDMI text to a USB-camera session.
Full contracts: `apps/backend/AGENTS.md` → "A DEBOUNCE IS NOT AN ABSENCE GRACE" and
"…AND ITS RAISE MUST BE SCOPED LIKE ITS RETRACTION".

**There is NO operator rename.** #206 briefly shipped an alias/rename UI backed by
`config.audio_device_aliases`; #207 removed it in full — UI, `setAudioDeviceAlias`
RPC, oRPC contract entry, `audio-aliases.schema.ts`, and the config field — by
explicit product decision. Device naming is code-level only. Instead, a pluggable
accessory carries a read-only **"External"** badge, decided by the engine's
`transport` field (`usb`/`bluetooth`; corrected in cerastream PR #69) and never
re-derived from bus-path string matching. Frontend label precedence is
`product_name · TRANSPORT` → `label` → `labelKey` → `id`. Full contract:
`apps/backend/AGENTS.md` → AUDIO-DEVICE NAMING.

**And the ladder is UNCHANGED on the engine's PipeWire audio arm — proven, not
assumed.** cerastream's `[audio] backend = "pipewire"` moved where a row's
identity is derived (PipeWire node props, resolved back through the engine's
`pw_identity.rs`) and left the vocabulary alone: an audio row's `id` is still
`hw:CARD=<card>` and `alsa_card_id` is still published, so the join key CeraUI
resolves on never moved. `tests/audio-naming-pipewire-arm.test.ts` renders one
physical roster as BOTH arms' `list-devices` payloads and drives each through the
real whitelist copy and the real ladder; the arms disagree about `device_path`
(which is not in the audio whitelist at all) and agree about everything the
ladder reads. The persisted-config half is the same test's acceptance: a
`config.asrc` written before any PipeWire work — an alias name, a bare card id,
or a raw `hw:CARD=`/`plughw:` selector — resolves to the same meter target on
both arms and to the literal pre-migration answer, so **no `asrc` migration is
required for the backend flip**. Full contract: `apps/backend/AGENTS.md` →
"…AND THE LADDER IS THE SAME ON THE PIPEWIRE ARM" and the pre-migration paragraph
under IDLE AUDIO-METER DEVICE PREFERENCE.

**RELEASE SEQUENCING — this CeraUI release ships WITH the image's PipeWire
release, not before or after it.** The device image's PipeWire adoption
(`image-building-pipeline`, system-mode PipeWire + BlueALSA retirement) removes
`bluealsad` from the board in the same release that adds the PipeWire stack, and
CeraUI's Bluetooth-microphone presence oracle switches arms on the engine's
`pipewire-capture` feature token rather than on an image version. The two halves
are therefore atomic by construction: an image carrying PipeWire under a CeraUI
that still drives `bluealsad` would offer an operator a Bluetooth path the device
no longer has, and the reverse strands a working BlueALSA path behind a token
that never arrives. Nothing in either repo can detect the mismatch, so it is a
RELEASE-ORDER obligation, recorded here for the release checklist rather than
enforced in code.

## THE WI-FI OFFERING IS DERIVED FROM THE RADIO [EXISTS]

The three-value band enum (`auto` / `auto_24` / `auto_50`) is still the **wire
vocabulary** and did not change. What changed is that nothing hardcodes which rungs are
*offered*. `wifi-capabilities.ts` derives per-adapter truth from `iw phy` and
`iw reg get` — bands, generation, per-band max width, SAE support, regulatory domain —
and publishes it on the additive, optional `wifiInterfaceSchema.capabilities?`. Absent
means "older device", and the UI must render today's legacy set for it, never an empty
offering. A DOM byte-comparison regression lock pins exactly that.

**Bind the adapter to its wiphy, never by position.** `iw dev` lists phys in
*descending* order (`phy#1` before `phy#0` on a dual board), so any positional read
binds the wrong radio. The binding is `basename(readlink('/sys/class/net/<if>/phy80211'))`,
which resolves for a virtual AP interface too.

**Generation keys on non-zero EHT, not on EHT presence.** The shipped RTL8852BE prints
`EHT MAC Capabilities (0x0000)` with every MCS/NSS `Rx=0, Tx=0` — an all-zero stub.
Keying on presence claims Wi-Fi 7 for a Wi-Fi 6 part; dropping the non-zero check
reddens six tests.

**A parse failure drops the cache; a spawn failure retains it.** The first says the
shape we knew how to read is gone. The second is a statement about the *read*, not
about the hardware. Self-managed wiphys get a shorter TTL (60 s vs 5 min) because their
domain moves with no operator action.

**Three degraded states, and collapsing any pair is the bug.** A radio that does not
carry a band renders **zero** nodes. A radio that carries it under a non-permitting,
non-self-managed domain keeps the chip, marks it `aria-disabled`, and offers "Set
country". A **self-managed** wiphy keeps the chip with a calm info band and **no
button** — it intersects or ignores a country hint, so the dialog is a control that
provably cannot act. Pointing the reason chip at the country dialog for a radio with no
6 GHz band at all would be the mirror error: blaming regulation for missing silicon.

**`00` is a kernel token, not a country.** The world-domain case gets its own sentence
rather than interpolating `00` into "the domain in force here ({country})".

### …AND A BAND'S AP RIGHTS COME FROM THE RULES, NOT THE CHANNEL FLAGS

Board-proven twice, and the second half is the part worth remembering. Under the
kernel's world domain `00` an RTL8852BE lists 5180/5200/5220/5745 with **no `no IR`
marker at all** — the per-channel flags are clean — yet every 5 GHz *rule* in
`iw reg get` reads `PASSIVE-SCAN` and the AP dies `Failed to start AP functionality`.
`PASSIVE-SCAN`, `NO-IR` and the ancient `NO-IBSS` are three spellings of one nl80211
flag published at rule level. `buildApInitiationGate` (`wifi-regulatory-rules.ts`) is
the single predicate, and four of its properties are load-bearing:

- **Band-scoped, not channel-scoped.** The world domain's `(2457 - 2482)` rule is also
  PASSIVE-SCAN, so a per-channel check would silently retire `ch_12`/`ch_13` — 2.4 GHz
  behaviour this defect does not touch.
- **Not a hardcoded 5 GHz block.** Replacing the rule-derived gate with `band !== "a"`
  reddens nine tests, including three pre-existing ES/US derivation cases.
- **Fails OPEN.** An unreadable or silent `iw reg get`, and any span no rule mentions,
  permits the band.
- **A per-phy section outranks the global one.** A self-managed wiphy can legally
  initiate on 5 GHz while the global scope still reads `00`.

**Two producers write into one offered list, so the gate is asked twice.**
`parseIwPhyChannels` builds the explicit `ch_*` entries; `wifi-interfaces.ts` pushes the
band-wide `auto_*` rungs from the adapter's *nmcli* band capability, one layer above.
A fix applied to the first alone left `auto_50` offered, accepted, and failing exactly
as the original defect did. `deriveApInitiationBands()` asks the same predicate one
layer up. **Only a rung that NAMES a band may be retired with that band** — the plain
`auto` rung was measured on the board before the fix was designed (it writes no band,
NM settles on 2462 MHz, activates cleanly), so withholding it would remove a control
that works. The suite refuses an over-reaching gate as well as an under-reaching one.

**`WifiHotspot.bandCapability` exists to avoid a one-way door.** `refreshHotspotChannels`
used to recover the adapter's band capability by filtering the autos out of
`hotspot.availableChannels`. The moment a rung is withheld from that list, the next
refresh reads a list that no longer contains it — the radio's 5 GHz capability is
forgotten **permanently** and the rung can never return when the operator sets a
permitting country. Any time a derived list is both the output and the input of a
recomputation, filtering it latches.

**Hosting and joining WPA3 are deliberately asymmetric.** Hosting needs positive proof
(`wpa3Sae: "supported"`); joining needs only the absence of disproof, so only a positive
`"unsupported"` withholds a row. NM 1.42.4 publishes no SAE key at all, so `unknown` is
the shipped fleet's answer and refusing on it would take WPA3 away from every board.
And `WPA2 WPA3` transition-mode APs must NOT pin `sae` — the AP accepts a plain WPA2
association, so pinning refuses the very leg a SAE-incapable adapter uses.

**6 GHz hotspot is refused STRUCTURALLY, not by a filter.** `HOTSPOT_BANDS` is
`["2.4","5"]` and the wire schema has no `'6'` key to emit into, so a Wi-Fi 7 adapter
with a self-managed US domain and `is6GhzLegal: true` still yields zero 6 GHz entries.
This is a NetworkManager/hostapd capability limit on the AP path, **not** a legal or
regulatory decision — see `docs/DIY-POSTURE.md` in the workspace root.

## THE BLUETOOTH FOUNDATION [EXISTS]

`modules/bluetooth/` observes BlueZ over the system D-Bus and publishes one snapshot:
adapter rows, the device registry, service/observation state, the pairing-agent state,
and a total capability-claims registry. Ten `bluetooth.*` procedures sit on top.

**Bluetooth reuses the five-state claim VOCABULARY without joining `CAPABILITY_MODULES`.**
That enum is closed, modem-only and default-off-forever, so registering Bluetooth in it
would put a headset behind a *cellular* feature gate — invisible by design. What is
shared is `supportClaimStateSchema` and `resolveSupportClaim`;
`bluetoothCapabilityClaimsSchema` is its own total registry
(`adapter`/`pairing`/`audio-input`/`battery`), gated on the operator's persisted
preference.

**The unit name is `bluealsa.service`; `bluealsad` is the binary.** Debian's
`bluez-alsa-utils` renamed the daemon upstream in bluez-alsa 4.x and kept the unit name.
Getting it wrong fails in the invisible direction: `systemctl enable --now
bluealsad.service` exits non-zero, the preference is still persisted, and the board comes
up with Bluetooth on and no ALSA PCM behind it. Bookworm's 4.0.0-2 actually installs
`/usr/bin/bluealsa`, so `BLUEALSA_BINARIES` accepts both spellings.

**`systemctl is-enabled` prints NOTHING on stdout for a unit systemd cannot find.** An
inline `stdout.trim() === "enabled"` reads that as "disabled", the reconciler reports
success forever, and nothing ever says the unit does not exist.
`parseUnitEnabledState` types the empty case separately and turns it into a
`unit_missing` record.

**Operator disable MUST be `disable --now`.** A stop-only disable leaves the unit
enabled, so "Bluetooth off" survives exactly until the next reboot and then reverses
itself — with `bluealsad` holding a headset's SCO leg on a device whose UI says
Bluetooth is off.

**`deviceClass` and `scoCapable` are two questions and the split is load-bearing.**
`audio-input` asks "can this be a source of audio at all"; `scoCapable` asks "can the
board open its mic over `PROFILE=sco`", which needs HFP (`111e`/`111f`) or HSP
(`1108`/`1112`) specifically. The forcing case is an A2DP-**source**-only device
(`110a` alone): genuinely an audio input, no SCO leg, so deriving `scoCapable` from "has
an audio UUID" publishes a row whose every open fails. `shortUuid` refuses to fold a
UUID outside the SIG base.

**BlueZ's `PropertiesChanged` is a DELTA.** An omitted key means *unchanged*, never
`false` — writing defaults for absent keys is how a headset that merely reported a new
RSSI publishes as un-paired and un-trusted. An unknown path is dropped rather than
minting a device from a partial view. And `InterfacesRemoved` is not a whole-object
delete: BlueZ retracts a single `Battery1` as readily as the whole device, so only
`Device1` removal retires a row.

**Board-proven: the projection tracks live BlueZ, and the fix was not where it looked.**
The registry delta rules were correct all along. Every live signal was being discarded
one layer earlier, in the shared transport's local sender filter: D-Bus accepts
`sender='org.bluez'` in `AddMatch` and then delivers with BlueZ's **unique** name
(`:1.x`), which `signalMatches` compared literally against `org.bluez`. Bluetooth
subscriptions now omit that predicate and keep the interface/member filters.

**The pairing agent is a real exported D-Bus object, on its own connection.**
`@httptoolkit/dbus-native` — already transitive — ships `exportInterface`, inbound
dispatch and `requestName`; the shared `DbusTransport` merely hides them.
`bluez-agent-exporter.ts` uses that object-server surface, and the **same** connection
both exports Agent1 and issues `RegisterAgent`/`RequestDefaultAgent`, because BlueZ
binds an agent path to the registering caller's unique bus name. No well-known name is
needed. `exportAgent` completes before `RegisterAgent`; an export failure returns
`export_failed` and registers **nothing** — registering a path nobody answers makes
BlueZ block on every callback until it times out, which is strictly worse than no agent.

**`NoInputNoOutput` ⇒ Just Works ⇒ `RequestAuthorization` is the only security gate**,
and it is gated on operator *intent*: the window is opened by `stack.pair(devicePath)`
for that device only and closed in a `finally`. Without that gate the agent accepts any
pairing from anyone in radio range, silently. Every PIN/passkey arm rejects rather than
inventing `0000`.

**The S5 lock keys on the ADAPTER path, not the device path** — two devices on one
controller contend for the same radio. Refusal (`ADAPTER_BUSY`, naming the holder)
rather than a queue: a "Forget" queued behind a "Pair" completes by forgetting the
device that was just paired, seconds after the operator stopped looking. Boot reconnect
is sequential for the same reason, and latched to once per process.

**The stack's `bt_unavailable` is NOT the operator's answer, and BOTH the mutation path
and the read path have to re-apply the gate order.** `BluetoothStack` records an
operator-disabled device as `bluez_unavailable`, truthful from its own point of view and
the exact opposite fact to an operator. A card rendering `unavailable.cause` literally
would band "the Bluetooth service isn't responding" over a radio the operator switched
off two seconds ago. One documented divergence in the ladder: `emulated` is answered
*before* the preference gate, because telling someone to switch Bluetooth on when the
host has no radio is advice they cannot act on.

**All thirteen typed refusals render INLINE, so `osCommand` gets `classify: () => ({ok:true})`.**
A structured `{success:false}` must stay `ok` as far as the async-op store is concerned,
or the operator gets the reason twice — once inline, once uselessly in a toast. A
*thrown* RPC still takes the toast path, correctly. `bluetoothRefusalKey` is typed
`Record<BluetoothMutationRefusal, string>`, so a fourteenth refusal fails `tsc` rather
than reaching an operator as its own dotted path.

**Absent is not `false` for the persisted preference.** `read()` answers `undefined`
when the operator has never decided, and the boot reconciler does **nothing** for it —
otherwise the first boot after an update disables `bluetooth.service` on every board in
the field on the strength of a file nobody has written yet.

**Ordering contracts, all pinned by tests:** reconcile the units *before* observing
BlueZ (a field board's `bluetooth.service` is disabled by the old image policy, so the
bus name has no owner and observation would report broken hardware); subscribe *before*
snapshot; export the agent object *before* `RegisterAgent`; write the BlueALSA drop-in
*before* `bluealsa.service` starts.

**Known gap, deliberately not papered over:** the dev mock provider
(`mocks/providers/bluetooth.ts`) has **no consumer** — `getBluetoothStatusMessage()`
builds the live payload from the real stack with no `shouldUseMocks()` seam, so a
session booted on `bt-mic-paired` broadcasts the dev host's honest "Bluetooth is off".
The e2e specs drop-and-inject over the page socket
(`tests/e2e/helpers/bluetooth-wire.ts`) and keep the scenario annotation so wiring the
seam is a one-file deletion. A boot-the-mock-service parity test is owed with it.

## THE BT MICROPHONE IS A SOURCE, NOT A SPECIAL CASE [EXISTS]

**The presence oracle follows the engine's configured audio backend, never BlueZ
`Connected`.** When the engine advertises the exact `pipewire-capture` feature token,
the oracle is its `list-devices` audio row whose optional `device_address` matches the
paired registry MAC; CeraUI sends that row's `input_id` (`node.name`) through
`AudioConfig.device` unchanged. A connected registry device with no matching engine
node yields no source. CeraUI compares the colon-form address case-insensitively and
keeps the persisted id byte-identical as `bt:<upper-case underscored MAC>`; it never
persists PipeWire `object.serial`.

Without `pipewire-capture`, the oracle remains the `org.bluealsa` capture PCM object
byte-for-byte. A device can be connected with no PCM behind it, and naming it as an
available source is a claim the device cannot honour. `scoCapable` + PCM present yields
the row; connected-but-no-PCM yields none; A2DP-only yields none.

The address is `bluealsa:DEV=<MAC>,PROFILE=sco`, routed through `AudioConfig.device`
unchanged: `toAlsaCaptureDevice` passes it through untouched because it already carries
`:`/`=`, so the opaque spec reaches the engine's `alsasrc device=` **verbatim**. The
engine half is cerastream's `AlsaPcmSpec::Opaque` seam, gated on the `audio-pcm-spec`
features token; the gate reads a `z.array(z.string())` wire field and **fails closed**
on the minimal-safe fallback rung, which carries no `features` at all. See
`cerastream/AGENTS.md` → OPAQUE ALSA PCM SPECS.

**The mic hint is gated on CONNECTED, not on paired.** A bonded-but-disconnected mic has
no PCM behind it — the same rule the `audio_source_unavailable` start class enforces one
layer down.

**`dropped` and `gone` are different BlueZ facts and must not be one band.**
`PropertiesChanged{Connected:false}` is expected back (the engine is already rebuilding
for it) and gets a retractable warning; `InterfacesRemoved(Device1)` needs a human and
gets a **terminal** error that REPLACES the warning in place rather than stacking. And
"we never saw it connected" is a third, silent state: a trusted mic switched off at boot
sits in the registry `connected:false` forever, and claiming it was *lost* would put a
standing error on a device that is merely off.

**Recovery is the ENGINE's; CeraUI only speaks.** There is no re-promote RPC anywhere on
the engine surface — `ProgramAudioBranch` is a device⇄silence `fallbackswitch` whose
actuator polls every 250 ms (silence at 1100 ms, rebuild on the 3 s cadence). A radio
flaps, so the verdict needs hysteresis and the re-assert needs a floor, and the two
bounds answer different questions: `BLUETOOTH_SOURCE_LOSS_GRACE_MS` (3 000) is sized
against the engine's own failover cadence so a drop the actuator absorbs stays silent,
while `BLUETOOTH_REASSERT_INTERVAL_MS` (5 000) is leading-edge. A 5-events-in-2 s storm
costs 1 re-assert, 0 notifications, and zero engine calls beyond the meter
`reload-config`.

**The publish order in `bluetooth-runtime.ts` is source-order-locked**: registry
projection → picker re-fold → presence reconcile. Getting it wrong is invisible in
steady state and only bites at boot, where the previous registry view is the empty one
and a trusted mic that just reconnected would be missing from the first source list an
operator sees.

**Board validation status:** the software path is fixture- and injection-proven and the
Bluetooth registry/pairing halves are board-proven, but **no physical BT microphone
exists at the bench**, so the picker → meter → stream → power-cycle drill has not run.
Recorded as a hardware gap, not a code gap, in
`docs/RELIABILITY-FINDINGS.md` → B4.

## ANTI-PATTERNS

- Don't run `npm install`, `yarn`, or `pnpm install` — this workspace runs **Bun** exclusively. `bun.lock` is the authoritative lockfile; `pnpm-lock.yaml`/`pnpm-workspace.yaml`/`.pnpmrc` are gone and catalogs live in `package.json` `workspaces.catalog`. Use `bun install`.
- Don't add `@ceralive/srtla` to `package.json` — that package is retired from CeraUI. The sender binding is `@ceralive/srtla-send` (public-npm registry dep, `@ceralive` scope). **`@ceralive/cerastream` is a public-npm registry dep** (`@ceralive` scope, pinned to a CalVer version; ADR-0002 Decision 13 / ARCHITECTURE §7) — never a sibling `link:` or vendored `.tgz`.
- Don't edit `.impeccable.md` for code changes — it's a design reference, not config.
- Don't decide a channel or band is AP-usable from the per-channel `iw phy` flags alone — board-proven, an RTL8852BE under the world domain lists 5180/5200/5220 with no `no IR` marker while every 5 GHz rule in `iw reg get` reads `PASSIVE-SCAN`. Ask `buildApInitiationGate`, ask it at **both** producers (the `ch_*` map and the `auto_*` rungs), don't "simplify" it into a hardcoded 5 GHz block, don't make it channel-scoped, and don't make it fail closed.
- Don't register Bluetooth in `CAPABILITY_MODULES` — that enum is closed, modem-only and default-off-forever; it would put a headset behind a cellular feature gate. Reuse the claim vocabulary, not the registry.
- Don't build the `org.bluez.Agent1` object on the shared `DbusTransport` — it is client-only. Use `bluez-agent-exporter.ts`'s dedicated connection, and never `RegisterAgent` a path before its object is exported: BlueZ then blocks on every callback until it times out, which is worse than having no agent.
- Don't treat BlueZ `Connected` as proof a microphone can be opened. The presence oracle is the address-matched engine node when `pipewire-capture` is advertised and the `org.bluealsa` capture PCM otherwise; a connected device with neither must yield no source row. Never persist PipeWire `object.serial` or change the existing `bt:` id.
- Don't touch `@ceralive/srtla-send` call sites without checking `../srtla-send-rs/AGENTS.md` first (binding API).
- Don't add custom UI components to `lib/components/ui/` — that directory is managed by the shadcn-svelte CLI. Custom components go in `lib/components/custom/`.
- Don't hardcode validation bounds (min/max lengths, bitrate limits, port ranges) in dialog components — import from `ValidationAdapter.ts` which sources from `packages/rpc/src/schemas/`.
- Don't hardcode timeout/retry values in streaming modules — import from `timing-constants.ts`.
- Don't shorten the audio-probe grace window or raise `attemptTimeoutMs` globally to resolve a probe-vs-deadline race — extend the `pendingGateRemainingMs` deferral seam instead (see STREAMING BACKEND QUALITY → bounded pre-engine gate).
- Don't add new exports to the streamloop barrel without updating the locked-API surface test in `tests/streamloop-modules.test.ts`.
- Don't re-add a `websocket-store` wrapper or a second `rpcClient.onMessage` owner — `subscriptions.svelte.ts` (connection/non-auth state) and `auth-status.svelte.ts` (auth mutation state) are the only two stores allowed to own this state; a CI grep gate blocks the literal module name from reappearing in `apps/frontend/src`.
- Don't re-derive the "gateway inactive" disabled-with-reason rule inline on a new surface — route through `pipelineAvailability.ts`.
- Don't delete `StreamSettingsCard.svelte`/`OnboardingChecklist.svelte`/`ServerReadiness.svelte`/`GoLiveCard.svelte`/`NetworkIngestSection.svelte` yet — they're unmounted-but-kept migration shims (`TD-unmounted-source-shims`); wait for the register entry's exit condition.
- Don't re-add per-link RTT/NAK/weight numbers to the WiFi/Cellular/Ethernet per-interface sections — `BondedLinksSection.svelte` is the sole owner of that telemetry on the Network destination.
- Don't add a device rename affordance (text field, button, or dialog) for ANY device or media type — device naming is code-level only (`ONBOARD_AUDIO_DISPLAY_RULES` / `ONBOARD_VIDEO_DISPLAY_RULES`); a pluggable audio device gets the read-only `isExternalAudioSource` "External" badge instead.
- Don't derive the apply-now timing choice from any predicate other than `restartChoiceRequired` — it is defined in terms of the same `appliesOnNextStart` the badge uses so the two can never disagree, and don't default the choice to `now` (a save must never restart a live broadcast by itself).
- Don't render a raw `config-change` reason token — route it through `configChangeReport`, which maps known reasons to keyed 10-locale copy and otherwise points at the in-app logs.
- Don't add a fifth fact to the compact HUD strip — the 4-fact scope (lifecycle badge, health dot, bitrate, one temp chip) is deliberate; anything else belongs in the expanded Sheet.
- Don't add a second QR to `HotspotDialog`, and don't interpolate a raw SSID/password into a `WIFI:` payload — route the credentials through `escapeWifiQrField` in `generateWifiQr` (see HOTSPOT QR SURFACE).
- Don't key a WiFi adapter (or pin a NetworkManager profile) on the MAC `ifconfig`/`GENERAL.HWADDR` reports — it is the scan-randomized OPERATIONAL address. Use `resolveWifiPermanentMac()`; see `apps/backend/AGENTS.md` → WIFI ADAPTER IDENTITY IS THE PERMANENT MAC.
- Don't generate a hotspot SSID/password before `findHotspotConnForAdapter()` and the credential store have been consulted — that ordering is what stops a new `Hotspot-N` profile appearing on every start.
- Don't delete a hotspot profile on ABSENCE (a MAC binding no present adapter claims) — that is what an unplugged radio looks like, and it destroys the credentials the store exists to preserve. Deletion needs positive ownership evidence from `hotspot_credentials.json`; see `apps/backend/AGENTS.md` → DURABLE PER-ADAPTER HOTSPOT IDENTITY.
