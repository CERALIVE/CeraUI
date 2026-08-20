# D-Bus transport board validation

A **test harness**, not product code. Nothing in `apps/backend/src` imports it and it is
never bundled into the shipped binary. It exists to prove, on real hardware and under the
service's real identity, that `@ceralive/modem-control`'s pure-JS D-Bus transport
(`@ceralive/modem-control/transport`, backed by `@httptoolkit/dbus-native`) can hold a
ModemManager subscription on the **system** bus under Bun.

The subprocess `busctl`/`gdbus` bridge is the documented fallback and is built ONLY if one
of the gates below goes red.

## Gates

| # | Gate | Observable in the JSONL |
|---|------|-------------------------|
| 1 | connect the system bus | `{"gate":1,"event":"connect","ok":true}` |
| 2 | `GetManagedObjects` snapshot | `{"gate":2,"event":"snapshot","modemCount":N}` |
| 3 | `InterfacesAdded`/`Removed` + `PropertiesChanged` + `NameOwnerChanged` | `{"event":"signal","member":…}` |
| 4 | survive a ModemManager restart | `{"gate":4,"phase":"resubscribed"}` then `"resnapshot"` |
| 5 | clean shutdown on `SIGTERM` | `{"gate":5,"event":"shutdown","ok":true,"subscriptionCount":0}` + exit 0 |
| 6 | sustained subscription, no fd/memory leak | `{"gate":6,"event":"sample","rssKb":…,"fdCount":…}` |

Every line is one JSON object on stdout (and, with `--log`, appended to a file), so a run is
machine-checkable from the journal alone.

## Running it

The harness MUST run as the packaged service identity — `User=root` / `Group=root`, the same
`WorkingDirectory`, `Environment` and cgroup surface as `deployment/ceralive.service`. Use a
transient systemd unit, never an interactive shell:

```sh
# bundle host-side (resolves the published @ceralive/modem-control from the workspace)
bun build apps/backend/test-harness/dbus-transport-validation/dbus-gates.ts \
  --target=bun --outfile=dbus-gates.js

# copy dbus-gates.js and a matching aarch64 `bun` to the board, then:
sudo systemd-run --uid=0 --gid=0 --unit=dbus-val --wait --collect --pipe \
  --property=WorkingDirectory=/opt/ceralive/ \
  --property=Environment=NODE_ENV=production \
  --property=KillMode=mixed \
  /path/to/bun /path/to/dbus-gates.js --snapshot-only
```

A transient unit is also how the long soak is detached: `systemd-run` **without** `--wait`
leaves PID 1 owning the process in its own cgroup, so it survives the launching SSH session
— and unlike a `setsid nohup` shell process it is still inside the unit context under test.

## Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--socket <path>` | `/run/dbus/system_bus_socket` | bus socket to dial |
| `--snapshot-only` | off | run gates 1–2 and exit 0 |
| `--duration-sec <n>` | `0` (run until signalled) | self-terminate after `n` seconds |
| `--sample-interval-sec <n>` | `300` | RSS/fd sampling cadence for gate 6 |
| `--log <path>` | — | also append each JSONL line to this file |
