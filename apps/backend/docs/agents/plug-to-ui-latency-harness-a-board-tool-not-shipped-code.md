<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## PLUG-TO-UI LATENCY HARNESS — a BOARD TOOL, not shipped code [EXISTS]

`scripts/modem-latency-harness.ts` + `scripts/lib/` time the whole path an
operator waits on: udev attach → ModemManager export → the row reaching a
WebSocket client on the device's own origin → a property update → detach.

```
sudo bun run modem-latency-harness --plug-cycle 4-1.3:4 --cycles 3 --assert
sudo bun run modem-latency-harness --observe-ms 420000 \
     --budgets ./scripts/lib/modem-latency-budgets-observe.json --assert
```

- **It lives in `scripts/`, not `src/`, deliberately.** It is never compiled into
  the `ceralive` binary, so it is outside the exec-guard's `SPAWN_POLICY`
  registration scope — registering it would assert it runs in production. It is
  also SELF-CONTAINED (no `src/` imports) because it has to run on a board that
  carries only the compiled binary and no source tree.
- **It measures the SHIPPED path.** The WebSocket client authenticates and
  consumes exactly what the frontend consumes, so a regression in the wire
  producer shows up as a real latency miss rather than as a passing unit test.
- **NEITHER pipe source is read-time stamped, and that was measured.**
  `busctl monitor` block-buffers when stdout is not a tty — an exploratory
  capture had a whole cycle's signals arrive in one burst ~40 s late — so both
  tools' OWN clocks are parsed instead: `busctl`'s per-record
  `Timestamp="… UTC"`, and `udevadm`'s `UDEV [<monotonic>]` header projected onto
  the epoch axis by a median-sampled `/proc/uptime` boot offset.
- **A row event is a transition between CONSECUTIVE FRAMES, never a diff against
  a fixed snapshot.** This is the correctness core. The frame a udev event causes
  arrives within milliseconds of it and carries a timestamp from a DIFFERENT
  clock, so it can sort just before its own cause, be adopted as the baseline,
  and hide the change it carried — measured on real captures as a 3 ms removal in
  one cycle and 11 s in the next, from identical hardware doing an identical
  thing. Small negative spans are CLAMPED to 0 rather than discarded, because
  discarding drops the fastest samples and biases every median upward.
- **`property_to_ui` is paired change-first, not signal-first** — the latest
  `PropertiesChanged` at or before a visible row change is its proximate cause.
  Walking signals forward pairs a first, inert signal (MM emits many that change
  nothing the wire projects) with a change some later signal produced, and
  reports the whole dead interval as latency.
- **NOT MEASURED is not a pass.** A budgeted interval with no samples returns
  `pass: null` and fails `budgetsAllGreen()`. That is why there are TWO committed
  budget files: a plug-cycle phase structurally cannot produce the steady-state
  property sample, and the observe phase cannot produce the attach/detach spans.
- **`mm_probe` and `end_to_end` carry no budget.** MM probe time is exempt by
  plan, and `end_to_end` is its sum with a budgeted span, so asserting it would
  double-count the exemption and fail the harness for ModemManager's behaviour.
- `--dump-dir` writes the raw `udev.txt` / `busctl.txt` / `status-frames.jsonl` /
  `derived.json` so every number is re-derivable offline. Both derivation bugs
  above were found and proven fixed by replaying a saved capture.

Committed budgets, derived from 9 measured cycles rather than chosen:

| Interval | Budget | Observed worst | Rationale |
|---|---|---|---|
| `optimistic_row` | 250 ms | 3 ms | 4× tighter than the plan's 1 s; approaching it means a poll or coalesce window was reintroduced |
| `authoritative_row` | 500 ms | 23 ms | deliberately the loosest — this path crosses the observer's snapshot refresh and `events.ts` coalescing — yet still 60× tighter than the 30 s poll it replaced |
| `removal` | 250 ms | 3 ms | cheapest path (cache delete + broadcast); 0 ms on 8 of 9 cycles |
| `property_to_ui` | 1000 ms (observe file) | no sample | UNTIGHTENED on purpose: never measured, because the bench's modems are SIM-less/searching so no property changes |

Coverage: `src/tests/modem-latency-harness.test.ts` (24 tests over verbatim board
captures — the parser table, the row-facts rules, the transition derivation
including a fixture whose frames precede their own cause, and the budget verdicts
incl. the not-measured arm).

