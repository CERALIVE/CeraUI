# APT transport ownership [PARTIAL — host-tested, not board-qualified]

On `transport-uidrange` images, APT owns a private write-ahead journal at
`/data/ceralive/update-state/apt-routing.json`. Each exact rule/route intent is
durable before its install. Checked deletion retires only that intent; table
flushes in the shared pin implementation become exact journal-authorized route
deletes on this APT-local path. File replacement fsyncs both file and directory.

A failed delete or journal acknowledgement retains ownership. The next APT
admission runs recovery only and returns an existing routing refusal even when
recovery succeeds; a subsequent request can proceed. Reconciliation submits no
command after its ten-second monotonic budget expires. Each command timeout is
bounded by the remaining budget. A missing already-deleted entry is reconciled.
Uncertain journal reads, malformed authority and failed persistence refuse.

The APT owner never adopts or sweeps unjournaled reserved state. Matching UID
rules or nonempty APT tables without journal authority refuse; the existing OS
startup/settlement sweep handles those. Foreign UID rules and nonjournaled routes
are not deleted by APT. There is no new wire/RPC format or operator override.

## D336 coexistence residual

The shared shape-based sweep and its OS consumers are unchanged. OS startup does
not wait for APT. An OS sweep may remove APT-owned routing early and fail that
transaction. Subsequent APT recovery accepts the already-absent journaled entries.
The APT journal is not exclusion against privileged processes writing identical
kernel rules or the reserved table concurrently; it records this owner’s intents,
not an unforgeable kernel ownership identity. DNS and method-descendant lifetime
limitations remain those in DEVICE-UPDATES.md.

Coverage: `d13-fix-cleanup.test.ts`, `d13-routing-journal.test.ts` and
`d13-routing-restart.test.ts`. The latter kills real Bun children before and after
all four installs and at transfer entry, then reloads the journal against a durable
stateful fake of Linux routing. It is not privileged kernel or board evidence.

## Cancellation and timeout provenance

The install captures an import-free cancellation epoch before dispatching its
asynchronous package check. Every admitted stream advances that epoch even when
no fetch controller is registered. A later idle observation cannot revive the
old admission. Immediately before each archive fetch/retry, the adapter checks
both that epoch and synchronous stream liveness. Active fetch cancellation still
uses the existing bounded runner; dpkg commit is never aborted by this adapter.

`runAptCommand` preserves its legacy result shape and records typed bounded-runner
provenance separately in a WeakMap. Only the pinned transfer boundary turns an
actual timeout into `blocked` failover and preserves partial output. A runner
abort is distinct, including its timeout superclass; arbitrary local apt failures
never gain failover from timeout-like message text. The shared maximum of three
pairs and fifteen-minute hold are unchanged.

Local callbacks receive the actual pinned family, including after an OS-shared
hold. URI estimation now runs through `within()`. The successful transfer family
also determines the detached argv and reported reachability.

## R4 remaining conditional network gap

The detached unit still runs a network-capable download stage after the attached
prefetch releases its pin. Cache equality is not network authority: another
permitted actor can change lists/cache in the interval, causing that unit to fetch
unpinned on the main route. The stale-family defect is fixed, but this routing
gap is NOT fixed and complete D13 transaction coverage is not claimed.

Closing it is not a small command deletion: it requires a single lock-owned
download/commit lifetime or a strictly cached-only unit variant, with matching
identity validators and restart/adoption contracts. Those command/recovery
contracts are deliberately unchanged by this fix. Review must assess this
explicit residual; it is not a waiver invented by the implementation.

Progress during the buffered attached prefetch still updates only at fetch exit.
A slow transfer can appear stalled until then. Probe data cost and apt-method
descendant retirement still need board measurements; these fixes do not qualify
metered-link performance, real kernel routing or either board.
