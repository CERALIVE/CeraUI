# Board token liveness probe [EXISTS]

This Bun-only probe is a local hardware gate, never a CI gate. It observes the
installed build without installing software, starting a hotspot, changing a
channel, or changing the regulatory domain. It needs `sshpass` and `ssh` on the
workstation and an already configured device.

```sh
flock /absolute/path/to/rock-board.lock \
  bun apps/backend/test-harness/board-gates/token-liveness.ts \
  --creds /absolute/path/to/board-creds.env \
  --cycles cold:3,restart:1,nm-restart:1 \
  --window 480 --out /absolute/path/to/result.json
```

Hold the shared board lock for the whole invocation. The credential file contains
`BOARD_IP`, `BOARD_SSH_USER`, `BOARD_SSH_PASS_FILE` and `UI_PASS`. The probe reads
the file itself as literal `KEY=value` lines, optionally quoted or prefixed with
`export`; it never sources shell text or expands variables. A relative SSH pass
file path resolves beside the credential env file. Keep these files outside Git.
No credential value or board address is printed or retained in the output:
every occurrence inside a JSON string value is replaced with `<redacted>`, while
keys, numbers and booleans are left intact. The SSH pass file loses only its
terminal line ending, so trailing spaces stay part of the password as `sshpass`
reads it.

All four flags are required. Cycle counts are positive integers (at most 100 per
entry); unknown kinds, empty entries, duplicate flags and malformed counts fail
before board access. The window is an integer of at least 30 seconds. `--help`
exits successfully without credentials. An unreadable credential file fails with
one error line and no JSON.

Before each cycle the probe requires a fresh authenticated status with
`is_streaming: false`, NetworkManager's `eth0:connected`, and the credential
address on `eth0` and absent from `wlan0`. A failed precondition records an aborted
cycle without triggering its action. `cold` invokes `sudo systemctl reboot`;
`restart` restarts `ceralive`; `nm-restart` restarts `NetworkManager`. Reboots
require explicit operator authorization before invoking the probe.

Each cycle records the original boot ID. After its action it waits up to 300
seconds for an accepted login and, for a cold cycle, a changed boot ID. That first
client remains connected without reconnecting. Fresh clients log in every five
seconds for the requested window. SSH calls have a 20 second deadline and each
WebSocket login/status read has a 15 second deadline; the retained client uses
keepalive/pong frames and fails a 30 second inbound silence check.

The JSON includes one object per cycle with `kind`, `bootIdChanged`, `polls`,
`tokenFirstSeenS`, `tokenAbsentPolls`, `noEligibleRowPolls` and `earlyClientTokenS`. Each poll retains
only `ifname`, `hasToken`, `degraded_reason` and `supports_hotspot` for each Wi-Fi
row. It never retains hotspot settings or authentication tokens. Absent-token
polls count polls at or after 30 seconds with any usable hotspot-capable row
missing its token. A row is eligible when it supports hotspot and has no
`degraded_reason`. `noEligibleRowPolls` counts polls at or after 30 seconds with
no eligible row, so a radio that degrades or loses hotspot support cannot pass by
exemption. Both each cycle and the whole run carry `pass`: every late poll must
contain at least one eligible row, all eligible rows must have tokens, and the
uninterrupted early client must have received a token-bearing status frame. Late
read failures and empty late observations cannot pass. If the first accepted login loses its client before
status hydration completes, the cycle fails rather than substituting a reconnect.
Package versions from `dpkg-query -W ceralive-device`
before and after must also match. The regulatory dump is recorded once.

Exit 0 means the gate passed; exit 1 means a completed run recorded a failing
verdict; exit 2 means invalid input, interruption or an incomplete run. A failing
released-build verdict is useful reproduction evidence. Output is written once,
using a temporary file and atomic rename, after all cycles and the final package
read. SIGINT/SIGTERM close clients, cancel SSH, and remove the temporary file.
A forced SIGKILL cannot publish partial JSON; an existing result remains intact.
Run in the foreground of `flock` so interruption also releases the board lock.

Host-only verdict tests:

```sh
bun test apps/backend/src/tests/board-token-liveness-probe.test.ts
```
