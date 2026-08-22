# Concurrent WiFi station and hotspot

**Status:** [PARTIAL — implemented and fixture-tested; physical-radio validation pending]

CeraUI can keep a WiFi station connection active while the same physical radio
hosts an access point, but only when the kernel driver positively advertises a
valid `managed` + `AP` interface combination and a virtual AP interface can be
created successfully.

## Capability contract

The backend maps each physical interface to its wiphy with `iw dev <ifname> info`
and parses `iw phy <phy> info`. A radio is eligible only when one complete
`valid interface combinations` alternative permits one `managed` interface and
one `AP` interface, with `total >= 2`. Group limits are respected, alternatives
are evaluated independently, and `#channels <= 1` is accepted because it means
the two interfaces must share a channel rather than forbidding concurrency.

Missing, malformed, unsupported, or unparseable output resolves unsupported.
The optional wire field `supports_ap_sta_concurrency` is emitted only after the
capability probe and virtual-interface creation both succeed. Older backends and
unsupported radios omit it, so the frontend never infers support.

## Runtime lifecycle

For a proven radio, the backend creates a deterministic `clap-<parent>` virtual
interface with cfg80211 type `__ap`. NetworkManager binds the hotspot profile to
that interface while the physical interface keeps its station profile and bond
membership. Start, confirmation, configuration, stop, process restart, and
profile adoption track the virtual AP separately from the station connection.

If support is absent, CeraUI retains the existing exclusive station-to-hotspot
switch. The UI states that starting the hotspot will disconnect WiFi and remove
that link from the bond; it never presents dual mode as available.

## Validation still required

The parser includes realistic Realtek `rtw89` and MediaTek MT7925-shaped fixtures,
and automated tests cover fail-closed parsing, wire projection, virtual-interface
creation, station-preserving start/stop, and legacy exclusive behavior.

No physical RTL8852BE or MT7925 radio has completed the end-to-end drill yet.
Required hardware checks are:

1. Verify virtual-interface creation and NetworkManager adoption.
2. Keep a station association and bond membership while starting/stopping the AP.
3. Confirm same-channel behavior when the driver advertises `#channels <= 1`.
4. Reboot with the hotspot enabled and verify profile re-adoption.
5. Exercise driver/firmware refusal and confirm the UI reports failure without
   disturbing the station connection.

Until those checks pass, support is implemented but hardware-validation-pending;
the capability advertisement is not a claim that every driver/firmware revision
will activate successfully.
