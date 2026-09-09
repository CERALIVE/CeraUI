# Portal credential regression fixture

`zte-mf79u/installed-summary.json` preserves the redacted ZTE summary from the
2026-09-08 Rock modem diagnosis. Its JSON values match the original captured
summary; formatting is normalized. The installed build was
`2026.9.1-20260906T194131.f3c52d5`.

The capture establishes a reachable router row, a stable port key and a `locked`
state with no configured credential. No portal password was submitted and no
settings write was attempted. Tests inject authentication outcomes against this
captured target; they do not claim a hardware-confirmed ZTE login protocol.

Subscriber identifiers remain redacted. Test-only password strings are authored
in the tests and are not credentials from a board. The complete raw capture and
fleet diagnosis are separate evidence, not reconstructed by this summary.
