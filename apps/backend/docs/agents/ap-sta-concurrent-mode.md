<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## AP+STA CONCURRENT MODE [PARTIAL — implementation complete; hardware validation pending]

`wifi-ap-sta-capability.ts` derives support from the kernel's own
`valid interface combinations` answer. One complete alternative must permit a
`managed` interface and an `AP` interface together; grouped limits and `total`
are enforced, and every absent/malformed/probe-error path resolves false.

`wifi-concurrent-interface.ts` retains the existing import surface. The one
selector in `wifi-hybrid-target-selector.ts` adopts the qualified NM-managed
leg only at admitted Start or saved-intent restore, after same-boot discovery,
parent/target lifetime, NM ownership and occupancy checks. Missing, foreign or
unreadable evidence refuses hybrid without creation or exclusive fallback.
Adoption grants reuse only. Exact nl80211 receipts alone grant creation cleanup;
an unrecorded or wrongly typed survivor is never deleted.

The optional wire flag is `supports_ap_sta_concurrency`; it is emitted only after
the driver data and the separate card qualification check admit the mechanism.
Discovery never creates a leg to advertise capability. Creation receipts, target
records, NM runtime policy and station channel checks live in separate modules,
with one authority store and one selector. Full contract and physical proof limits:
[`docs/AP-STA-CONCURRENT-MODE.md`](../../../../docs/AP-STA-CONCURRENT-MODE.md).

Coverage: `tests/wifi-ap-sta-capability.test.ts`,
`tests/wifi-concurrent-interface.test.ts`, `tests/wifi-hotspot.test.ts`.

