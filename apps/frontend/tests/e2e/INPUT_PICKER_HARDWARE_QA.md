# Rock 5B+ input-picker hardware gate

This is the required real-hardware proof for the input-picker live-switch
contract. The normal PR E2E run keeps the `@hardware` case visible as an
annotated skip with an exact prerequisite; its deterministic mock-negative cases
remain useful, but they are not a hardware pass.

The gate is complete only when the automated case exits zero on a Radxa ROCK 5B+
and every artifact listed below exists and is non-empty. Never infer a hardware
pass from the mock suite, a skipped test, source inspection, or a prior run.

## Preconditions

- A Rock 5B+ is running the exact CeraUI commit under review from its
  device-hosted production build. `ceralive.service` and `cerastream.service`
  are active.
- The CeraUI process has `NODE_ENV=production`; `MOCK_MODE`, `MOCK_SCENARIO`, and
  dev server overrides are unset.
- Two physical capture inputs with live pictures are available. The primary
  input is attached and already streaming. The target input is unplugged before
  the Playwright case opens the UI.
- The device already has a password. The test refuses the first-run password
  form instead of changing device credentials.
- Run Chromium headed so the operator can time the two physical actions from
  the visible Live cockpit.

With both inputs attached once, start on the primary input and read the stable
engine ids from the live switch rows in DevTools:

```js
[...document.querySelectorAll('[data-source-switch-row]')].map((row) => ({
  id: row.getAttribute('data-source-switch-row'),
  label: row.textContent?.trim(),
}))
```

Record those ids, stop the stream, unplug the target, restart
`ceralive.service` to clear prior lost-row memory, then start the stream on the
primary input only. Do not restart either service after the test begins.

## Invocation and physical actions

From the CeraUI checkout root, create the run directory and capture the initial
device state before starting Playwright:

```bash
RUN_STARTED_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
RUN_STARTED_JOURNAL="$(date -u '+%Y-%m-%d %H:%M:%S UTC')"
RUN_DIR="apps/frontend/test-results/input-picker-rock5b-$RUN_STARTED_UTC"
mkdir -p "$RUN_DIR"
printf '%s\n' "$RUN_DIR"
git rev-parse HEAD >"$RUN_DIR/ceraui-commit.txt"
ssh root@<rock-5b-plus-ip> '
  set -eu
  tr -d "\0" </proc/device-tree/model; echo
  systemctl is-active ceralive.service cerastream.service
  pid=$(systemctl show ceralive.service -p MainPID --value)
  tr "\0" "\n" </proc/$pid/environ |
    grep -E "^(NODE_ENV|MOCK_MODE|MOCK_SCENARIO|CERALIVE_DEVICE_TYPE)=" || true
  dpkg-query -W -f="\${Package} \${Version}\n" ceraui cerastream 2>/dev/null
' >"$RUN_DIR/preflight.txt"
ssh root@<rock-5b-plus-ip> 'v4l2-ctl --list-devices' >"$RUN_DIR/v4l2-before.txt"
```

`preflight.txt` must identify
`Radxa ROCK 5B Plus Board based on Rockchip RK3588`, show both services active,
show `NODE_ENV=production`, and contain no `MOCK_MODE` or `MOCK_SCENARIO` line.
The target must be absent from `v4l2-before.txt`.

Set the password in the shell without recording it in command output. Then run:

```bash
export CERAUI_INPUT_HARDWARE_PASSWORD='<device password>'
export CERAUI_INPUT_HARDWARE=1
export CERAUI_INPUT_HARDWARE_URL='http://<rock-5b-plus-ip>/'
export CERAUI_INPUT_PRIMARY_ID='<running input_id>'
export CERAUI_INPUT_TARGET_ID='<unplugged target input_id>'
if PLAYWRIGHT_JSON_OUTPUT_NAME=input-picker-rock5b-report.json \
  bun run --filter frontend test:e2e -- \
    --config=tests/e2e/playwright.hardware.config.ts \
    --headed --reporter=line,json; then
  PLAYWRIGHT_EXIT=0
else
  PLAYWRIGHT_EXIT=$?
fi
printf '%s\n' "$PLAYWRIGHT_EXIT" >"$RUN_DIR/playwright-exit-code.txt"
```

The test performs no WebSocket interception or injection. It passively records
the RPC WebSocket origin and real `sources` broadcasts.

In a second shell at the checkout root, set `RUN_DIR` to the exact path printed
by the first shell. Then perform these actions:

```bash
RUN_DIR='<paste the exact path printed by the first shell>'
```

1. When the headed page reaches the live cockpit with no target switch row,
   plug the target capture input. Keep its video source running.
2. The test waits for real hotplug discovery and clicks the target Switch
   control. Do not touch the UI. From that second shell, capture the attached
   state before unplugging:

   ```bash
   ssh root@<rock-5b-plus-ip> 'v4l2-ctl --list-devices' >"$RUN_DIR/v4l2-attached.txt"
   ```

3. When the target row visibly becomes Active, unplug that target. The test
   waits for the real lost-source broadcast and retained disabled row. Then
   capture the detached state:

   ```bash
   ssh root@<rock-5b-plus-ip> 'v4l2-ctl --list-devices' >"$RUN_DIR/v4l2-detached.txt"
   ```

The test fails unless the success toast reports `<=67ms`, the target becomes
authoritatively active, and unplug produces `available:false, lost:true` on the
device-origin WebSocket.

## Required artifact bundle

The UTC-dated `RUN_DIR` created above is the artifact bundle. Redact no fields
listed here; do not capture passwords, tokens, or unrelated environment
variables.

1. `ceraui-commit.txt`, containing the exact CeraUI commit deployed for the run.
2. `preflight.txt`, satisfying the exact model, service, production-mode, and
   no-mock checks above.
3. `v4l2-before.txt`, `v4l2-attached.txt`, and `v4l2-detached.txt`. Together,
   they must show the target absent, then present, then absent.
4. `playwright-exit-code.txt`, containing exactly `0`.
5. `input-picker-rock5b-report.json`, the Playwright JSON reporter output.
6. `input-picker-rock5b-hardware.json`, emitted only after every automated
   assertion passes. It records the device UI/RPC origin, RK3588 source class,
   input ids, observed switch gap, active state, and attach/detach observations.
7. `journals.txt`, captured after Playwright exits from the first shell:

   ```bash
   ssh root@<rock-5b-plus-ip> \
     "journalctl -u ceralive.service -u cerastream.service --since '$RUN_STARTED_JOURNAL' --no-pager" \
     >"$RUN_DIR/journals.txt"
   ```

8. `signoff.md` containing the CeraUI Git commit, deployed package versions,
   board serial or lab asset id, operator, UTC start/end, exact primary/target
   physical devices and input ids, command exit code, observed gap, and a
   pass/fail line for attach, switch, active state, and detach.

Copy the generated JSON files into `RUN_DIR`, then verify the bundle before
claiming a pass:

```bash
cp apps/frontend/input-picker-rock5b-report.json "$RUN_DIR/"
cp apps/frontend/test-results/input-picker-rock5b-hardware.json "$RUN_DIR/"
test -s "$RUN_DIR/ceraui-commit.txt"
test -s "$RUN_DIR/preflight.txt"
test -s "$RUN_DIR/v4l2-before.txt"
test -s "$RUN_DIR/v4l2-attached.txt"
test -s "$RUN_DIR/v4l2-detached.txt"
test -s "$RUN_DIR/playwright-exit-code.txt"
test "$(cat "$RUN_DIR/playwright-exit-code.txt")" = 0
test -s "$RUN_DIR/input-picker-rock5b-report.json"
test -s "$RUN_DIR/input-picker-rock5b-hardware.json"
test -s "$RUN_DIR/journals.txt"
test -s "$RUN_DIR/signoff.md"
jq -e '.stats.expected == 1 and .stats.skipped == 0 and .stats.unexpected == 0' \
  "$RUN_DIR/input-picker-rock5b-report.json" >/dev/null
jq -e '
  .schemaVersion == 1 and
  .status == "passed" and
  .deviceClass == "rk3588" and
  .observed.realAttach == true and
  .observed.switchSuccess == true and
  .observed.switchGapMs <= 67 and
  .observed.targetBecameActive == true and
  .observed.realDetachLostBroadcast == true
' "$RUN_DIR/input-picker-rock5b-hardware.json" >/dev/null
```

A failed or interrupted run keeps its report for diagnosis but does not produce
`input-picker-rock5b-hardware.json` and therefore cannot be signed off. Traces,
screenshots, and videos are disabled because this gate enters a device password.
