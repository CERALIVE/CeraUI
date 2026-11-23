# Real Debian 13 observation corpus

This is new data from the retained R19, R20 and R21 guest evidence, not a
regeneration of existing test fixtures. `manifest.json` records 42 source
captures and 49 command-level samples, their provenance and SHA-256 values.
Duplicate copies of one R19 device reply share a sample with both origins.

The captures preserve all retained guest output, including cloud-init, versions, module
information, dependency-install output, iw, rfkill, nmcli, systemd/bus replies,
journal JSON, safe process/PID inventories, masked keyfiles and diagnostics.
Command samples select the independently replayable replies from those
transcripts. Outputs that the producer did not retain cannot be reconstructed.

For R19-R21, the only retained phy output is the first 10,000 characters of phy0, recovered
from an assertion's string-literal representation without evaluating it.
The producer truncated another 25,867 characters. The sample is explicitly
incomplete, has a final newline added, and still contains the real supported
AP mode and `2437.0 MHz [6] (20.0 dBm)` row. No phy1/2/3 reply is invented.

R22 adds four complete, unchanged 35,879-byte iw 6.9 replies in
`manifest.json.additionalSamples`. The original 42 captures and 49 samples
remain unchanged. Each new entry records its archive/member origin and exact
SHA-256; the archive hash is
`6e86342c9388fb3eb72925e4d43f7c97125080eedbdd91b3e242520f3e9dc145`.
The R22 replay runs the production capability and channel parsers on all four
full replies, covering S1G omission, shared managed/AP capacity, decimal MHz,
no-IR/disabled restrictions and preserved channel 6. These replies also exist
as backend regression fixtures so the parser fixes can be backported alone.

Sanitization replaces the known harness PSK and credential assignments with
`<redacted>`, replaces host evidence paths with `<evidence>`, normalizes final
newlines and JSON presentation, and preserves protocol labels, whitespace
within values, IDs, timestamps and state transitions. Empty captures are
marked in the manifest. Original source hashes distinguish recorded bytes
from sanitized fixture bytes. The files are data and are never sourced or
evaluated as code. The corpus is a curated benchmark capture, not a general
secret-discovery or security boundary.

Run from the CeraUI repository:

```bash
cd apps/backend
taskset -c 0-3 bun test --timeout 20000 \
  ./test-harness/wifi-hwsim/checks/replay.test.ts \
  ./test-harness/wifi-hwsim/checks/replay-*.test.ts
```

## Consumer coverage

| Consumer | Evidence and replay |
| --- | --- |
| Profile-add UUID decoder | All three real `Connection ... successfully added` replies run through the existing product decoder. |
| Device/status/association | Every real three/four-column inventory runs through the shared escaped-separator decoder, managed-readiness predicate and exact CeraTest association predicate. The real unavailable -> disconnected sequence drives the actual bounded waiter. |
| Bootstrap preparation | The actual shell initializer and bootstrap checker run in a private namespace against a static command model emitting real R21 disconnected and R20 connected inventories. Creation alone fails; explicit activation establishes the fixture. |
| Version predicates | All seven complete R21 replies and exit statuses drive the actual version script, including the absolute nmcli route. Other retained partial version transcripts remain available as captures. |
| Phy capability predicates | The actual shared numeric-MHz/AP decoder projects the real decimal-frequency reply into the unchanged native matchers. Disabled, wrong-frequency and AP/VLAN-only counterexamples fail. Integer display is also covered as a derived control. |
| Runtime AP/channel predicates | Every real iw interface block drives every literal AP/channel matcher from preflight, first-AP and hybrid. A station can also be on channel 6; AP identity is checked independently. |
| Journal/audit parsing | Both complete real journal streams drive the actual extracted JSON/audit decoder and unrelated-profile guard. |
| Persisted bytes/field differences | All 16 real masked keyfile samples drive the actual serializer/hash and profile-diff paths and offline autoconnect predicate. No secret visibility is inferred from redacted values. |
| Process columns | Both safe real process listings drive the actual native whitespace matcher. |
| Literal matchers | The replay inventory visits all 21 native literal regex sites and routes them to compatible recordings or explicit protocol controls. Unreviewed matcher sites fail the test. |
| Dynamic matchers | Both actual template constructors are replayed: audit field names against real JSON and the SSID matcher against recorded unrelated formats plus a labeled protocol control. |
| Framing/od bytes | The committed `framing.sh` preserves the original Python byte verifier. Replay invokes that exact trusted verifier with derived controls named from a real captured connection. Loss of the value LF is rejected. Raw named-field stdout was not retained. |
| Terminal/JSON diagnostics | The actual terminal decoder rejects unrelated real JSON records; schema/device/accepted controls cover the missing frame shape. The real first-AP diagnostic boundary consumes recorded string/array/object values and reports shapes without dumping values. |
| Failed-intent text | Real console captures cannot invent an intent failure; existing native selfchecks cover the positive controlled log shape. |

Regex enumeration is a replay inventory, not a promise of exhaustive source
analysis. The semantic decoders are shared by native checks and replay.
The fixed sample bytes and reviewed oracles provide the deterministic input
contract; namespace tests cover filesystem/execution mechanics separately.

## Explicit missing observations

No native framing, first-AP or hybrid case ran in R19-R21.
Positive real samples are therefore unavailable for:

- `iw dev <client> link` and wrong-radio activation stderr.
- NM named multiline field stdout, escaped FILENAME/DBUS-PATH summaries,
  numeric `GENERAL.STATE` replies and raw VersionId replies. Success markers
  do not supply their missing bytes.
- Non-secret terse `--fields all` profile snapshots, secret-visibility changes,
  real foreign edit/readback races and their stat/version transitions.
- Raw mountinfo and escaped mountpoint replies from the guest.
- Terminal hotspot broadcasts, private hybrid state files, private shim-event
  JSONL, failed-intent backend log output and the hybrid PID-call ledger.
- NM restart/physical-radio readiness timing, station+AP concurrency, DHCP
  behavior and the lifecycle/control outcomes of later native cases.

Protocol controls are labeled in test code and are not counted as guest
recordings. These gaps remain `UNVERIFIED-GUEST-ONLY`. Future runs should add
new samples rather than rewrite this corpus. The preflight now saves full
safe iw replies before validation and records bootstrap observations so
those formats will no longer be lost in truncated assertions or quiet tests.
