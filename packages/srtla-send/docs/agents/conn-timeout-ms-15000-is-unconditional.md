<!-- Moved verbatim from AGENTS.md on 2026-10-05 by lean-rules-docs-landing-latam -->

## `--conn-timeout-ms 15000` IS UNCONDITIONAL

`buildSrtlaSendArgs` emits `--conn-timeout-ms 15000` on EVERY spawn, with no
option to suppress it. It is not a preference.

The sender is a hard fork of upstream `irlserver/srtla_send`, which ships
`CONN_TIMEOUT = 5` s. CeraLive needs 15 s — the interval the bonding receiver
holds a link open while it keeps echoing keepalives. At 5 s the sender gives up
on a link that is merely mid radio-stall, falsely re-registers, and resets its
congestion window. The fix is deliberately NOT a patched Rust constant (that
would be fork divergence to re-resolve on every upstream sync); the device value
is asserted on the command line instead, through upstream's own flag.

So: do not make it optional, do not let it default, and do not drop it in a
"simplify the args" pass. `buildSrtlaSendArgs_exact_vector_snapshot` (this
package) and the positional-contract test in
`apps/backend/src/tests/srtla-send-bindings-skew.test.ts` both pin it.

The four positionals still lead the vector in their frozen order —
`<listen_port> <srtla_host> <srtla_port> <ips_file>` — and the flag block starts
after them.

