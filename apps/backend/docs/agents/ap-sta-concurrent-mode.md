<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AP+STA CONCURRENT MODE [PARTIAL — implementation complete; hardware validation pending]

`wifi-ap-sta-capability.ts` derives support from the kernel's own
`valid interface combinations` answer. One complete alternative must permit a
`managed` interface and an `AP` interface together; grouped limits and `total`
are enforced, and every absent/malformed/probe-error path resolves false.

`wifi-concurrent-interface.ts` creates the deterministic `clap-<parent>` cfg80211
`managed` interface and waits for NetworkManager to observe it. An existing
interface is reused only after its reported type is confirmed as `managed`; stale
or wrongly typed instances are deleted before recreation. Hotspot profiles on
proven radios bind to that virtual interface, so the physical interface retains
its station connection and bond state. Confirmation, polling, saved-profile
adoption, reconfiguration, and stop track the virtual AP separately. Radios that
do not prove support use the pre-existing exclusive path unchanged.

The optional wire flag is `supports_ap_sta_concurrency`; it is emitted only after
both the `iw phy` parser and runtime virtual-interface creation succeed. Full
contract and the outstanding RTL8852BE/MT7925 board drill:
[`docs/AP-STA-CONCURRENT-MODE.md`](../../../../docs/AP-STA-CONCURRENT-MODE.md).

Coverage: `tests/wifi-ap-sta-capability.test.ts`,
`tests/wifi-concurrent-interface.test.ts`, `tests/wifi-hotspot.test.ts`.

