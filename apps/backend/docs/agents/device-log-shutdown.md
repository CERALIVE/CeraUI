# Device log shutdown classification [EXISTS]

`src/modules/device-logs/classified-boots.ts` exports the classified `listBoots()`
surface for the logs RPC and device-start event consumers. It composes the
discovery-only `boots.ts` public API without changing that independently owned
module or its tests. Query admission still uses discovery-only boot membership.
The RPC composition must import the classified surface when wiring boot history.

`shutdown-classifier.ts` exports pure `classifyBoot({ isCurrent, tail,
nextBootHead, storeEvents })`. Inputs are already parsed journal records and
events belonging to the classified boot. Tail records are newest first in
journal traversal order, not timestamp order. Head records are oldest first.
The first matching rule wins:

| Evidence | Shutdown | Evidence token |
|---|---|---|
| Current boot | current | none |
| PID 1 names exactly shutdown/reboot/poweroff/final.target in UNIT | clean | shutdown_target |
| Newest lifecycle record is journald stopped | clean | journal_stopped |
| Following boot's systemd-journald message contains `uncleanly shut down` or `corrupted` | unclean | next_boot_unclean_journal |
| At least 20 tail records without clean markers | unclean | no_shutdown_markers |
| Empty tail | unknown | no_entries |
| Fewer than 20 records without markers | unknown | too_few_entries |

The lifecycle IDs are stopped `d93fb3c9c24d451a97cea615ce59c00b` and started
`f77379a8490b408bbe5f6940505a777b`. A restart writes stopped then started;
the newest started marker prevents that restart from proving a clean shutdown.
Ordinary records after the last lifecycle marker do not change that decision.
A stored `shutdown_requested` adds `shutdown_requested_event` only to
`no_shutdown_markers`; intent and `service_stopping` never prove completion.

`shutdown-window.ts` reads at most 100 reverse tail records or 50 forward head
records, with only the exact `_BOOT_ID` match. It uses `scanJournal` or the public
mock adapter selected through `shouldUseMocks()`. An incomplete budget or
unexpected cancellation fails with `READ_FAILED`; reader errors propagate.
There is no timestamp inference, background process, timer or new spawn policy.

The classified list follows the discovery list's journal order. Stored-only
boots are unknown with no entries and are never treated as a following journal
boot. Current boots need no classification scan. A per-boot promise cache
shares concurrent reads and retains completed classifications once a following
journal boot exists. The newest finished boot without one is reread until that
following boot appears. Failures leave no cached result. Each response copies
evidence so callers cannot mutate the cached summary.

Tests cover the pure decision table, the bounded reader composition and the
classified list with cache and event isolation. The landed systemd 257
conformance suite already proves stopped/started lifecycle ordering around
clean shutdown and restart followed by kill. Its separate per-unit flood now
proves suppression MESSAGE_ID `a596d6fe7bfa4994828e72309e95d61e` with exact
dropped-record accounting. This supersedes the earlier unproven-notice
statements in the frozen reader, paging and conformance documents; their
original broad-flood experiment and all its assertions remain unchanged.

The added `rate-limited-flood.service` sets `LogRateLimitIntervalSec=2s` and
`LogRateLimitBurst=1`, writes 6,000 info records, then writes an error-priority
barrier and waits on a FIFO. Receiving that barrier proves journald examined
the preceding records. A transient timer releases the same unit three seconds
later; its next info record causes journald to report the suppressed count.
The harness polls journalctl for that notice under a 15-second timeout,
without a fixed sleep. The original paging, vacuum and lifecycle cases remain.

`test-harness/journal-conformance/assert-suppression.sh` requires the exact
suppression ID, the originating unit in the message, and `N_DROPPED` equal to
6,000 minus the stored info-record count. The real systemd 257.13 run stored
3 records and reported 5,997 suppressed records. Counts can vary with
journald's disk-space multiplier; the assertion checks accounting rather than
assuming a fixed multiplier. The notice JSON is printed as
`SUPPRESSION_LIMITED_JSON` before cleanup.

`device-logs-suppression-conformance.test.ts` exercises that assertion's
positive and negative cases, then passes the captured native record from
`src/tests/fixtures/device-journal-suppression-257.json` through the unchanged
parser and classifier. It becomes `marker: 'suppressed'` and does not prove a
shutdown. These small assertion tests require Bash and jq on the test host.
Physical device latency, CPU and streaming volume are unmeasured.
