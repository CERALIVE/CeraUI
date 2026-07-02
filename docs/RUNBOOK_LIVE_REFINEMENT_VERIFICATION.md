# Runbook: Real-Device Verification — Live Truth Refinement

**Status: RUNBOOK.** Every step in this document is executed by a human, on real
hardware, with a keyboard and a browser in front of them. Nothing here runs in
CI and nothing here is a merge gate. It gates **release sign-off** — a human
checks every box below, dates it, and only then does the `feat/live-truth-refinement`
work get called done on real devices. If you are looking for the automated
proof that this branch is safe to merge, that lives in the CI jobs and in
Wave 5's verification todos (30-34); this document does not repeat them and
does not replace them.

Do not mark any step in this runbook as "CI-passing." There is no CI here.

## Who this is for

An operator with:

- Physical access to a CeraLive device (Jetson, RK3588, or N100 board) running
  a CeraLive OS image, reachable over SSH and HTTP/WS on the LAN.
- A RØDE HDMI-to-USB-C capture dongle (or equivalent UVC-raw HDMI dongle) and
  an MJPEG-only UVC webcam, both pluggable into the device's USB ports.
- A laptop on the same network, with a Chromium-based browser (for the
  DevTools Network/WS frame inspector used in a few steps below).
- Local checkouts of `CeraUI` and `cerastream` with the `feat/live-truth-refinement`
  branch checked out in both.

## Part 1 — Get both artifacts onto the device

This plan produced two different cerastream artifacts. Use the right one for
the right job — they are not interchangeable.

### 1a. Quick local-verification `.deb` (Todo 12 artifact — content-check only)

```text
/mnt/development/ceralive/cerastream/dist/cerastream_2026.6.1_amd64.deb
```

This is an **amd64** build (host arch, not the device's arm64) produced purely
to prove the packaging recipe is sound: `dpkg -c` lists `/usr/bin/cerastream`,
the `cerastream.service` unit, and the bundled `libgstfallbackswitch.so`. It
was built before the `2026.7.0` release cut and it will not run on an arm64
board. **Do not install this on the device.** Its only use is a package-content
sanity check on the build host:

```bash
dpkg -c /mnt/development/ceralive/cerastream/dist/cerastream_2026.6.1_amd64.deb \
  | grep -E "usr/bin/cerastream|cerastream\.service|libgstfallbackswitch"
```

### 1b. Real arm64 release `.deb` (the one you actually install)

The genuine article ships from cerastream's `publish-release.yml` once the
draft PR [`CERALIVE/cerastream#19`](https://github.com/CERALIVE/cerastream/pull/19)
merges and a `v2026.7.0` tag is cut (Todo 35 already published the npm
bindings at `2026.7.0`; the `.deb` release is the same version, built by the
same CI run for both `arm64` and `amd64`). Two ways to get it once it exists:

- **GitHub Release asset** (fastest, works before `apt-worker` catches up):
  `gh release download v2026.7.0 --repo CERALIVE/cerastream --pattern 'cerastream_2026.7.0_arm64.deb'`
- **apt** (once the `apt-worker` repository-dispatch has run — see
  `apt-worker/AGENTS.md`): `apt-get install cerastream=2026.7.0` from
  `apt.ceralive.tv`.

Install it on the device over SSH:

```bash
scp cerastream_2026.7.0_arm64.deb root@<device-ip>:/tmp/
ssh root@<device-ip> "dpkg -i /tmp/cerastream_2026.7.0_arm64.deb && systemctl restart cerastream.service"
ssh root@<device-ip> "cerastream --version"   # expect: 2026.7.0
ssh root@<device-ip> "systemctl is-active cerastream.service"   # expect: active
```

**If the tag isn't cut yet:** build the arm64 `.deb` locally from the branch
with the same packaging recipe Todo 12 used (`cerastream/packaging/`), install
it the same way, and note in your sign-off that this was a pre-release
verification build, not the CI-signed release artifact.

### 1c. Push the CeraUI side with dev-sync

CeraUI itself doesn't ship as a `.deb` for this runbook — push it live with
the fast-reload loop (canonical reference:
[`image-building-pipeline/v2/docs/fast-reload.md`](../../image-building-pipeline/v2/docs/fast-reload.md)
and [`dev-loop.md`](../../image-building-pipeline/v2/docs/dev-loop.md)):

```bash
# One-time per device:
ssh root@<device-ip> bash < image-building-pipeline/v2/lib/dev-sync/setup.sh

# From the workspace root, watch and push both frontend + backend on save:
image-building-pipeline/v2/dev-sync --frontend --backend
```

Confirm the backend picked up the release pin before starting the numbered
steps below:

```bash
ssh root@<device-ip> "cat /opt/ceralive/package.json 2>/dev/null | grep cerastream || true; systemctl status ceralive.service --no-pager"
```

Everything after this point assumes: `ceralive.service` is running the
pushed build, `cerastream.service` is running the `2026.7.0` arm64 `.deb`, and
you can reach the device UI at `http://<device-ip>/` and the preview socket at
`ws://<device-ip>:9997`.

---

## Part 2 — Numbered verification steps

Each step lists the exact operator action, the exact expected result, and an
evidence-capture command. Capture every evidence artifact into a dated folder,
e.g. `~/ceralive-verification/2026-07-02/`, named `step-N-<slug>.<ext>`.

### Step 1 — RØDE HDMI-to-USB-C groups under USB, correctly labeled (never HDMI)

**Action:** With nothing else USB-attached, plug the RØDE HDMI-to-USB-C dongle
into the device. Feed it a live HDMI source. Open `http://<device-ip>/` →
Live destination. Look at the "Video Input" picker section (`data-testid="input-picker"`
in the DOM) and read the group heading above the RØDE device entry.

**Expected result:** The RØDE dongle appears under the **"Cam Link"** group
heading — one of the USB-family groups (`Cam Link` / `UVC H.264` / `UVC H.265`
/ `MJPEG` / `USB`, per the engine-reported `kind`), never under **"HDMI"**.
This is the driver-not-name regression guard from Todo 17: the device's
kernel driver, not its USB product string ("RØDE HDMI to USB-C" *contains* the
word HDMI), decides the group. If it lands under "HDMI," this step fails.

**Evidence:**

```bash
# Screenshot the input picker with the RØDE entry + its group heading visible.
# File: step-1-rode-grouping.png

# Cross-check the raw device kind reported by the engine over the RPC WS —
# open Chrome DevTools → Network → WS → the ceraui connection → Messages tab,
# filter for "list-devices" or "devices", and confirm the RØDE entry's
# "kind" field is NOT "hdmi":
ssh root@<device-ip> "journalctl -u cerastream.service -n 200 --no-pager | grep -iE 'hdmirx|hdmi_rx|rk_hdmi|camlink|driver'"
```

### Step 2 — Preview toggle → live picture on `ws://device:9997`, WebCodecs tier, audio meters moving

**Action:** On the Live destination, click the preview toggle
(`data-testid="preview-toggle"`). In a browser tab that supports WebCodecs
(current Chrome/Edge), confirm the preview canvas paints a live picture within
3 seconds of toggling on. Independently, from a browser dev console, open a
raw WS to the preview socket and confirm the handshake:

```js
const ws = new WebSocket("ws://<device-ip>:9997");
ws.onopen = () => ws.send(JSON.stringify({ action: "start", tier: "webcodecs" }));
ws.onmessage = (e) => console.log(typeof e.data, e.data instanceof Blob ? "(binary AU)" : e.data);
```

**Expected result:** The first console line logged is the `codec-config` JSON
frame (`{"type":"codec-config","tier":"webcodecs",...}`); the `preview`
element (`data-testid="preview"`) in the app carries `data-tier="webcodecs"`
and `data-status="live"` within 3 seconds; the canvas
(`data-testid="preview-canvas"`) shows a moving picture matching the HDMI
source; the audio level meter bars next to the preview move in response to
sound at the source (silence = flat bars, not frozen/absent).

**Evidence:**

```bash
# Screenshot the live preview with visibly-moving audio meter bars.
# File: step-2-preview-live.png

# Confirm the engine's preview server logged the connection:
ssh root@<device-ip> "journalctl -u cerastream.service --since '-2 min' --no-pager | grep -iE 'preview|9997'"
```

### Step 3 — Start stream on the UVC source → active-config line shows H.265 (RK3588 default) + `active_encode` matches; decoder used = the detected candidate

**Action:** Select the RØDE (or another UVC H.26x) source in the input picker,
leave codec at **Auto**, and start the stream. Watch the "Configured"/"Live"
active-config line (`data-testid="source-active-config"`,
`data-testid="active-config-value"`) in the Source section.

**Expected result:** Once streaming, the label pill reads "Live" and the
active-config value string reads `<source> · <resolution> · <fps>fps · h265 ·
<transport>` on an RK3588 board (H.265 is the profile default per
`cerastream-hal::profiles::Rk3588`). This must match the engine's own
`active_encode` field on the status frame — the UI never invents this value,
it only mirrors what the engine reports (Todo 10/23).

**Evidence:**

```bash
# Screenshot the active-config line reading "... h265 ...".
# File: step-3-active-config-h265.png

# Cross-check the raw active_encode object AND the decoder element the engine
# selected (Todo 7's capability-detected decoder-selection seam) via the WS
# status frame — Chrome DevTools → Network → WS → the ceraui connection →
# Messages, filter "status", inspect the "active_encode" object: confirm
# codec="h265" and decoder is one of the RK3588 candidates
# (mppvideodec / v4l2slh26xdec), never a software fallback on this board.

# Confirm the same decoder element from the engine side — bump GStreamer's
# element-factory verbosity for this one check, then grep the journal for the
# element name (revert the override afterward, it is chatty):
ssh root@<device-ip> "systemctl edit cerastream.service" # add: Environment=GST_DEBUG=GST_ELEMENT_FACTORY:5
ssh root@<device-ip> "systemctl restart cerastream.service"
# ... restart the stream from the UI, then:
ssh root@<device-ip> "journalctl -u cerastream.service --since '-1 min' --no-pager | grep -iE 'mppvideodec|v4l2slh26xdec'"
# Revert: ssh root@<device-ip> "systemctl revert cerastream.service && systemctl restart cerastream.service"
```

### Step 4 — Explicit H.264 selection round-trips

**Action:** Stop the stream. Open the Encoder dialog, select the explicit
**H.264** codec segment (`data-testid="encoder-codec-selector"` →
`codec-h264`), save, and start the stream again on the same UVC source.

**Expected result:** The active-config value string now reads `... h264 ...`
(not h265) — the explicit operator choice overrides the platform default.
Stop and restart without touching the codec selector: it stays on H.264 (the
selection persisted in config, not just the in-memory draft).

**Evidence:**

```bash
# Screenshot the active-config line reading "... h264 ..." after start.
# File: step-4-explicit-h264.png

ssh root@<device-ip> "journalctl -u ceralive.service --since '-2 min' --no-pager | grep -iE 'video_codec|setConfig'"
```

### Step 5 — Input pick honored at start

**Action:** With at least two capture devices attached (e.g. the RØDE dongle
and the MJPEG webcam from Step 6), explicitly select the second device in the
input picker (not the currently-active one) and start the stream.

**Expected result:** The active-config value's leading `<source>` token names
the device you picked, not whatever was previously active or first in the
list. The picked device's row in the input picker shows the "active" indicator
once streaming.

**Evidence:**

```bash
# Screenshot the input picker (picked device highlighted) side-by-side with
# the active-config line naming that same device.
# File: step-5-input-pick-honored.png

ssh root@<device-ip> "journalctl -u cerastream.service --since '-2 min' --no-pager | grep -iE 'input_id|switch-input|start'"
```

### Step 6 — MJPEG-only USB device falls back correctly

**Action:** Unplug every UVC H.26x-capable device. Plug in a USB webcam that
only advertises MJPEG (no H.264/H.265 UVC compression pad). Refresh the input
picker.

**Expected result:** The device appears under the **"MJPEG"** group heading
(not silently dropped, not misclassified as "USB"/"Other"). Selecting it and
starting the stream succeeds — the engine transcodes MJPEG → the platform's
default encode codec (H.265 on RK3588) rather than failing or falling back to
the videotestsrc pattern. The active-config line shows a real resolution/fps
pulled from the camera, not the test-pattern defaults.

**Evidence:**

```bash
# Screenshot: input picker showing the device under "MJPEG", then the
# active-config line after starting the stream on it.
# File: step-6-mjpeg-fallback.png

ssh root@<device-ip> "journalctl -u cerastream.service --since '-2 min' --no-pager | grep -iE 'mjpeg|jpegdec|vajpegdec|mppjpegdec'"
```

### Step 7 — Idle panel shows real link readiness

**Action:** Stop any active stream. With the device's SRTLA links (WiFi/modem)
actually connected and bonded, look at the idle Live destination panel
(`data-testid="ingest-idle-ready"` when links are ready,
`data-testid="ingest-idle-empty"` when none are).

**Expected result:** With real bonded links present, the panel reads the
"links ready" state and lists the actual ready link count/names
(`data-testid="ingest-idle-ready-links"`) — never a flat "no bonded links"
message when links genuinely exist. Physically disconnect every link
(unplug modems, disable WiFi) and confirm the panel flips to the empty state
within a few seconds — it reflects live network truth, not a cached snapshot.

**Evidence:**

```bash
# Screenshot the idle panel in the "ready" state with real link names, then
# a second screenshot in the "empty" state after disconnecting all links.
# Files: step-7-idle-links-ready.png, step-7-idle-links-empty.png

ssh root@<device-ip> "journalctl -u ceralive.service --since '-2 min' --no-pager | grep -iE 'srtla|link|bonded'"
```

### Step 8 — Idle + live bitrate adjust

**Action:** While idle (not streaming), locate the bitrate slider on the Live
destination (`BitrateAdjuster`, rendered outside any "Advanced" disclosure —
it must be reachable without expanding anything) and drag it to a new value.
Then start the stream and drag it again while live.

**Expected result:** The idle adjustment persists into the config used at the
next stream start (start the stream right after and confirm the applied
bitrate matches what you set, via the encoder summary or the stats panel).
The live adjustment takes effect on the running stream within a couple of
seconds (visible bitrate telemetry moves toward the new target) — no need to
stop/restart the stream, and no need to open the Encoder dialog's Advanced
section for either adjustment.

**Evidence:**

```bash
# Screenshot 1: idle bitrate slider at a new value, no Advanced section open.
# Screenshot 2: live stats/telemetry showing bitrate tracking the new
# live-adjusted target.
# Files: step-8-bitrate-idle.png, step-8-bitrate-live.png

ssh root@<device-ip> "journalctl -u ceralive.service --since '-2 min' --no-pager | grep -iE 'bitrate|reload-config'"
```

### Step 9 — Audio device/delay applied (lip-sync sanity)

**Action:** Open the Audio dialog. Select a specific audio input device
(distinct from whatever is currently active) and set a non-zero delay value
(e.g. +150ms). Save while idle, then start the stream. Play a clap-test or
countdown source through the selected audio device while watching the video.

**Expected result:** The stream's audio comes from the device you selected
(confirm via the preview's audio meter reacting to that device specifically,
e.g. mute it and see the meter go flat). The configured delay is audibly
applied — a viewer/receiver-side comparison of the clap sound against the
clap's video frame should show the expected offset direction/magnitude for
the delay you set (a positive delay pushes audio later relative to video).
This is a human sanity check, not a frame-accurate lab measurement.

**Evidence:**

```bash
# Screenshot the Audio dialog with the selected device + delay value visible
# before save.
# File: step-9-audio-config.png

# A short screen+audio capture (or phone video of the monitor + speaker)
# showing the clap-test offset is the strongest evidence here; attach it
# alongside the screenshot.
ssh root@<device-ip> "journalctl -u ceralive.service --since '-2 min' --no-pager | grep -iE 'asrc|acodec|delay_ms'"
```

---

## Part 3 — Sign-off

This section is filled in by the human running the runbook, not by an agent.

| Step | Result (pass/fail) | Evidence file(s) | Date | Operator |
|------|---------------------|-------------------|------|----------|
| 1. RØDE grouping | | | | |
| 2. Preview live | | | | |
| 3. UVC start → H.265 + decoder | | | | |
| 4. Explicit H.264 round-trip | | | | |
| 5. Input pick honored | | | | |
| 6. MJPEG-only fallback | | | | |
| 7. Idle link readiness | | | | |
| 8. Idle + live bitrate | | | | |
| 9. Audio device/delay | | | | |

**Board(s) used:** _(record RK3588 / Jetson / N100 + specific model)_
**cerastream version installed:** _(dpkg -l cerastream, or `cerastream --version`)_
**CeraUI commit pushed via dev-sync:** _(git rev-parse HEAD at push time)_

This runbook does not block PR merge for
[`CERALIVE/CeraUI#134`](https://github.com/CERALIVE/CeraUI/pull/134) or
[`CERALIVE/cerastream#19`](https://github.com/CERALIVE/cerastream/pull/19).
It gates the human release sign-off that happens after those PRs merge. Link
this file from both PR descriptions when you run it.
