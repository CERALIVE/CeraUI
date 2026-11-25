# Read-only AT on the RM520's released port

One modem fact has no ModemManager, QMI or MBIM source: the RM520N-GL's
serving-cell report with the NR band on NSA (`AT+QENG="servingcell"`).
`mmcli --command` cannot carry it on a stock device:
ModemManager answers `Modem.Command` only when the daemon runs with `--debug`,
and turning that on restarts the daemon (every bearer drops) and opens any AT
command, setters included, to every authorised caller. Inhibiting the modem
takes its data path down for as long as it is held.

So the backend reads this one query on a port ModemManager has released.

## The released port

Releasing the port is optional and happens outside CeraUI: a modem support
package (for example `ceralive-modem-support`) sets `ID_MM_PORT_IGNORE=1` (an
ENV property, nothing else) on the tty of USB interface 3 of `2c7c:0801`,
ModemManager's secondary AT port. Without that release ModemManager keeps the
port, so a read reports `owned-by-modemmanager` (the ownership check runs
first), or `not-released` when ModemManager doesn't list the port but the
property is missing. Either way the radio health panel uses its other readings
and names the reason. This PID is shared by RM520N-GL and RM530N-GL; `not-rm520`
is a compatibility reason code for a failed PID check, not a model probe.
ModemManager then lists the port as `(ignored)`, or omits it, and never
opens it. It keeps the primary AT port on interface 2, the control port and the
data port. The property takes effect when the modem is next probed.

## The lease (`apps/backend/src/modules/modems/free-at-port.ts`)

Before every open, all must hold, or nothing is opened:

| Check | Refusal reason |
| --- | --- |
| ModemManager's physical device is a USB device with `2c7c:0801` | `not-rm520` |
| Exactly one tty on its interface 3 | `second-at-interface-absent` |
| ModemManager's port list does not name it, or names it `(ignored)` | `owned-by-modemmanager` |
| The udev database has `E:ID_MM_PORT_IGNORE=1` for it | `not-released` |
| No process holds it open | `in-use` |

The port is then opened `O_NOCTTY | O_NONBLOCK`, made exclusive (`TIOCEXCL`) and
raw, and the same checks run again with the backend's own descriptor excluded.
The USB generation (`busnum:devnum`) must be unchanged (`device-changed`). A
failed open is `in-use` (EBUSY), `cannot-open` or `native-unavailable` (libc
not loadable). Line settings are restored and exclusivity dropped on close.
`TIOCEXCL` stops other unprivileged openers only; root bypasses it, which is
why the holder scan runs both before and after the open. ModemManager's
device path must be a plain `/sys/devices/…` path without `.` or `..`.

Structural refusals are remembered for ten minutes. In-use, cannot-open and
device-changed retry after 30 seconds. Three consecutive timeouts also cause a
30-second refusal, reset by a successful read or another query failure.
Close runs asynchronously on the fs pool and is awaited for at most 500 ms
inside the serial queue. An overrun returns `port-stuck`. Both ordinary close
and failed-native-setup cleanup remain registered by physical sysfs device, tty and USB busnum/devnum
until settlement, independently of the 30-second backoff. Replacing the
ModemManager ID cannot reopen that same port generation. A freshly verified
new USB generation may open when the earlier descriptor passed its post-open
identity check, even for the same manager ID, after all pre-open
and post-open ownership checks pass; a different modem is also independent.
This relies on USB re-enumeration isolating the old descriptor from the new
device generation. If open crosses generations, or failed setup cannot verify
which generation it opened, cleanup also guards the physical device/tty across
all generations until it settles.
Polling pending cleanup does not renew backoff. A same-generation reopen still
observes the backoff after cleanup settles. This bounds the wait for close, not
other filesystem/ownership work or the kernel close itself. Reads are serialised across all modems.

## The exchange (`free-at-session.ts`)

- Only `AT+QENG="servingcell"` can be written, followed by
  CR. Any other string is refused before anything is looked at. There is no
  `ATE0` and no setter.
- A fresh open drains first: input is flushed and the port must be quiet for
  50 ms within 300 ms (`port-not-quiet` otherwise). A query that ended without
  a final result code leaves the session dirty, drained again before the next
  write.
- A final code counts only after this command’s echo or its expected `+QENG:`
  prefix line. A complete `OK` then finishes the reply. `ERROR`,
  `+CME ERROR` and `+CMS ERROR` are `modem-error`; no final code before the
  deadline is `timeout`; more than 16 KiB is `reply-too-long`; a vanished port
  is `port-failed`. Only consecutive timeouts are remembered as described above.

Callers say "not available" with the fixed reason when the lease refuses, and
"no reading" when a query fails. Neither path falls back to a ModemManager-owned
port, to inhibition or to debug mode.

## Tests

`src/tests/free-at-session.test.ts` drives a fake modem on a pty: echo, partial
lines, `OK` split across reads, `OKAY`, `OK` absent, the late end of a timed-out
reply, the three error finals, an endless reply, a vanished port, a noisy port,
exclusivity and restored line settings, and that no non-allowlisted byte is ever
written. `src/tests/free-at-port.test.ts` builds a fake sysfs/udev/proc tree for
each refusal, and checks the lease's remembered refusals, re-enumeration between
check and open, busy and failed opens, timeouts and serialisation.

## Still to verify on the real modem

Interface 3 shows as `(ignored)` and stays closed by ModemManager; ModemManager
and data behave as before with only interface 2; the query answers on
interface 3 within the deadline; the interface numbers in every offered USB composition. RM530N-GL layout,
stalled-driver close duration and HUPCL effects also remain hardware-unverified.
