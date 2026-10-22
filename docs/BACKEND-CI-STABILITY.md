# Backend CI stability [EXISTS; host-tested]

These are test-harness contracts, not device boot-time, network-health or update
latency guarantees. Product timeouts and admission policy are unchanged.

## Fresh-process credential clock continuity

`credential-clock-restart.test.ts` deliberately uses three independent Bun VMs
per case: publication, an early-clock restart, then a corrected-clock restart.
The real ledger and notification owners reload private files; no in-process
module cache stands in for a restart. Its clock is already injected.

Each child now has a named 45-second deadline with forced termination and scoped
disposal. The test has a derived 145-second hang budget for three children plus
parent assertions/cleanup. This distinguishes slow source/import scheduling from
broken continuity without changing a single notice identity or state assertion.
The cold-start headroom is measured, not assumed: in a fresh checkout under the
reviewer's heavy-contention recipe (four same-core burners, test at nice 5), the
first child took up to 20.2 s wall (1.1-1.2 s quiet, against about 0.3 s for later
children), so the deadline clears that worst case by more than 2x. The global
default remains five seconds. These bounds are not an arbitrary-load latency
promise.

## Real transport namespace setup

The `netns-semantics` workflow step runs after the parallel backend suite with
`CERALIVE_NETNS_ISOLATED=1`. Its transport fixture needs Linux user/network
namespaces (or passwordless sudo), veth support, `ip`, `nsenter`, Bash, OpenSSL,
GPG and curl. Servers bind ports 80/443 inside private namespaces. The separate
UID routing fixture needs rootful namespaces and port 8088; a single-ID user
mapping cannot exercise its nonzero UID. No ip6tables rule or live DNS service is
required by the selector fixture: IPv6 blackhole and resolver replies are injected,
while IPv4 device-bound sockets, TLS and signed-index checks are real.

A background `unshare` PID can still name the parent's namespace before its
`unshare(2)` executes. Moving a veth to that PID then moves it to the wrong
namespace. A marker published inside the new namespace now precedes each move.
Actual TCP listener readiness replaces a fixed 300 ms sleep before the client.
Both waits are bounded and fail with setup diagnostics; no unsupported environment
is converted into a pass or a new skip. Existing privilege-probe errors remain
explicit. The ordinary regression delays both namespace creation and listener
startup while driving the same shell and real veth operations.

## Package-scope sweep

`update-orchestrator-package-scope-sweep.test.ts` retains all five authority flips,
the scoped and unscoped controls, real quarantine I/O, all assertions and the
five-turn continuation drain. Macro=0 retains all 41 microtask offsets, including
the bare recovery-await window missed by dependency-port fault injection.

For later macrotask offsets, the microtask scan stops when the call completed
before the flip; increasing the offset is outside that observed call lifetime.
Remaining flipper waits are cancelled once the call settles. The existing outer
scan still stops on a macrotask row without a live flip. Counters report actual
cases, live flips, OS stages and wall time rather than claiming a fixed number of
physical scheduler interleavings. This is a bounded scheduling sample, not an
exhaustive enumeration of arbitrary filesystem or kernel timing. The separate
dependency-port race matrix remains necessary.

Replay reviewer mutants R1 (remove the final pre-OS recheck) and R2 (treat `{}` as
scoped), and author mutants A1–A7, when changing this sampling scheme. Preserving
assertions alone is not proof of preserving the regression coverage.
