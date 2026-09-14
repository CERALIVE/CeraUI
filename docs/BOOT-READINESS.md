# Backend startup readiness [EXISTS]

`ceralive.service` is `Type=notify`, not `Type=simple`. Its readiness boundary is:

1. The JavaScript boot-signal guards are installed.
2. Configuration loads and the HTTP/WebSocket control server binds successfully.
3. The backend acknowledges readiness through `systemd-notify`.
4. Optional subsystem initialization continues.

Readiness means the control server is bound and the process can safely receive
its boot notifications. It does **not** mean every engine, radio or add-on is
available. Those failures retain their existing degraded-but-up behavior.

## Why process creation was not sufficient

The post-boot add-on oneshot is ordered after `ceralive.service` and
`network-online.target`. It sends SIGUSR1 to request a reconciliation pass.
With `Type=simple`, systemd released it immediately after spawning the backend,
before native-runtime startup and import evaluation installed a JavaScript
handler. SIGUSR1's default disposition terminated the process.

A diagnostic Rock 5B+ reboot confirmed the caller: PID 1 spawned systemctl in
`ceralive-addon-reconciler.service`; that process logged sending
`org.freedesktop.systemd1.Manager.KillUnit`, and PID 1 then logged the matching
signal delivery followed by the backend's `status=10/USR1` death. Root systemctl
used a private manager connection, so a system-bus monitor alone missed the call.
USB coldplug was concurrent, not the identified source of this SIGUSR1.

## Notification contract

`helpers/systemd-ready.ts` invokes `/usr/bin/systemd-notify` through the bounded,
argv-only command runner. The service remains root-owned and
`NotifyAccess=main`; `--pid=parent` attributes readiness to the backend rather
than adopting the short-lived helper. Do not add `--no-block`: the helper waits
for the manager's acknowledgement before exiting. Notification failure is a
critical startup failure. Standalone execution without `NOTIFY_SOCKET`, and
non-production development/test execution, issue no notification.

The unit and binary must be deployed together. Installing the notify unit over
an old binary leaves startup waiting for a notification that binary never sends.
The existing systemd startup timeout remains in force.

The add-on oneshot keeps its main-PID-only SIGUSR1 and its nonfatal stopped-unit
behavior. The boot guard coalesces pokes until add-on initialization arms the
handler. Reconciliation itself remains fire-and-forget and never gates boot or
the update healthcheck. No sleep or coldplug-settling delay is involved.

## Scope and verification

### Browser telemetry hydration

Service readiness and a browser's initial telemetry snapshot are separate
boundaries. The functional browser harness starts a development-mode Bun child;
it does not start this systemd unit, and `notifyServiceReady` sends nothing there.
Moving the production notification cannot establish browser hydration.

The `device-stats` collector now retains its latest completed sample before
broadcasting. The authenticated browser adapter sends that sample at login,
without waiting for another five-second tick. Previously this event was absent
from the initial push, so a client connecting after a broadcast missed data the
backend already held. An unchanged tick can also be coalesced when it completes
just inside the previous tick's five-second window; increasing an assertion
timeout would leave that delivery gap intact.

The retained sample is replaced whole, including omitted optional fields. Before
the first sample there is no invented reading; the ordinary first broadcast
still supplies it. No collector, engine, radio or add-on is moved ahead of the
control-server bind or made a prerequisite for systemd readiness.

`device-stats-initial-push.test.ts` proves login delivery over a real WebSocket
with no subsequent collector tick. `device-health-initial-snapshot.spec.ts`
proves the rendered Device Health readouts while suppressing periodic telemetry
only; it forwards the actual login snapshot and injects no fixture values.
The existing observability spec and its assertion bounds are unchanged.

### Signal barrier

The barrier protects the **ordered add-on sender**. It cannot protect a signal
sent before JavaScript starts by an unordered caller; the udev SIGUSR2 rules are
such callers and retain their existing behavior. The separate provisioning stop
timeout is not attributed to this signal race.

Regression coverage: `sigusr1-boot-race.test.ts` pins the shipped unit and the
readiness ordering; `systemd-ready.test.ts` covers acknowledgement, standalone
execution and notification failure. Existing guard/replay and PID-scoping tests
remain intact.

Board verification must select journals by normalized boot ID, never wall-clock
ranges: an invalid RTC followed by clock synchronization can hide early deaths.
Count PID-1 `ceralive.service: Main process exited, code=(killed|dumped),
status=10/(SIG)?USR1` events, preserve query exit status and stderr, and validate
an empty result against a retained boot known to contain that event. A running
service after automatic restart is not evidence of a clean boot.

The readiness candidate was measured on a real Rock 5B+ reboot: the service
became ready at monotonic 11.571870 s, received the unchanged add-on SIGUSR1 at
11.635691 s, and retained its original process with zero restarts through 322 s.
The death query returned zero; the identical query returned one on both a
retained failing Rock boot and the original failing Orange Pi boot. Running
executables were verified through `/proc/<MainPID>/exe`, not package metadata.
This is a bounded idle-reboot result, not a physical power-cut test or evidence
about the Orange Pi's separate streaming-triggered watchdog failures.
