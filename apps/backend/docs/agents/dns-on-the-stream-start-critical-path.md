<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## DNS ON THE STREAM-START CRITICAL PATH [EXISTS]

`dnsCacheResolve` (`modules/network/dns.ts`) sits INSIDE the per-attempt launch
deadline: `streaming.start` → `session.start` → `updateConfig` → `resolveSrtla`
→ `dnsCacheResolve`, all before the sender spawn and any engine IPC. It is the
only network round-trip CeraUI itself adds to a start.

It runs TWO lookups — a `wellknown.belabox.net` health check (the captive-portal
/ hijacked-DNS gate) and the caller's own query. **They are independent: the
check only GATES whether the answer is trusted, it is never an input to it.**
Awaiting them in series therefore put a second full DNS round-trip on every
stream start for no ordering reason, and on a bad link cost up to
`2 × DNS_TIMEOUT` (4 s) of a 10 s `attemptTimeoutMs` budget — time the engine
start then no longer had, turning a start that would have succeeded into a
deadline-cancelled retry. They now fly concurrently and the call costs
`max(check, query)` instead of `check + query`.

- **The gate is byte-identical.** The caller's answer is used ONLY when the
  well-known name resolved to `DNS_WELLKNOWN_ADDR`. A speculative answer from a
  network that failed the check is discarded unread and `dnsResults[name]` is
  deleted, exactly as before. Its error is deliberately NOT logged — the serial
  version never issued that query, so logging it would invent a new failure line.
- **Separate `Resolver` instances are REQUIRED, not an optimisation.** A c-ares
  channel's `cancel()` on timeout aborts every pending query on that channel, so
  sharing one would let a timing-out leg kill its sibling mid-flight. `resolveP`
  now always builds its own; the old "reuse the resolver after a successful
  validation" path is gone.
- **An unspecified record type waits for both families.** The A and AAAA queries
  run concurrently on separate resolvers and each owns its timeout. The result
  remains `{addrs, fromCache}` and `addrs` is always every A answer followed by
  every AAAA answer; a missing family contributes nothing, while both live lists
  are retained by `dnsCacheValidate`. This ordering makes `addrs[0]` the IPv4
  preference on a dual-stack host without making an IPv6-only host fail.
- **Every default-record consumer was audited with that contract.** `gateways.ts`
  iterates the complete list (the family race is a separate change);
  `uplink-health/connectivity-target.ts` deliberately takes the A-first first
  element; and the legacy remote relay keeps selecting any cached family but
  passes the literal through `formatUrlHost` before constructing its WebSocket
  URL. The relay is not documented as IPv4-only, so forcing an A lookup there
  would discard a valid IPv6-only endpoint.
- **`setDnsResolverFactoryForTest(factory | null)`** is the test seam (mirrors
  `setIfaceResolverForTest` / the `set*Runner` seams) — a `DnsResolverLike`
  double, no process-wide `mock.module` on `node:dns`.
- Unchanged: the literal-IPv4 short-circuit (a raw-IP relay address still issues
  ZERO queries), the `DNS_TIMEOUT`, and the persisted-cache fallback.

Do NOT re-serialise these two lookups, and do NOT "simplify" the two resolvers
back into one shared instance.

Coverage: `tests/dns-parallel-resolve.test.ts` (the caller's query is dispatched
before the health check settles, distinct resolver ids per leg, both bad-DNS
branches discard the speculative answer, query-failure falls back, the IPv4
short-circuit, AAAA-first/A-first/one-family outcomes, both-family cache
retention, and IPv6 URL handling at all three consumers).

