# Device Stats + Hardware-Preview Board Validation Runbook

Status: **OPEN — none of the legs below have been run.** This is a checklist for a
future human or agent with physical access to a real vendor-kernel Rock 5B+ (and,
for leg (iv), a board without the preview hardware-encoder element). Nothing in
this document, or anywhere else in this repository, claims any of these legs have
passed. Every item stays unchecked until it is actually exercised on hardware.

## Scope

This runbook covers **only what CeraUI observes**: the wire payloads CeraUI's
backend receives and renders (`device-stats`, `encoder-load`, preview
capability/status), and the CeraUI-side preview toggle. It does not attempt to
qualify the kernel or verify core-to-core binding — that is the exclusive scope
of the sibling `image-pipeline-quality` effort's board-qualification checklist.
See "Sibling kernel qualification" below for the cross-link.

Nothing in this document asserts a **core-identity** claim (e.g. which physical
encoder core did which work) — see leg (iii) for the exact honest phrasing CeraUI
already uses on the wire and in its UI.

## Sibling kernel qualification (cross-link, not duplicated here)

Kernel/core-binding qualification is owned by the sibling `image-pipeline-quality`
effort's board-qualification checklist, tracked in the `rk3588-kernel-patches`
repository:

**https://github.com/CERALIVE/rk3588-kernel-patches/blob/main/docs/BOARD-QUALIFICATION.md**
(pending — created by the image-pipeline-quality effort)

That document, once it exists, is the place to look for kernel-side legs such as
core-binding verification, VEPU580 driver qualification, and HDMI-RX capture
timing. Nothing in this runbook duplicates those legs; do not add kernel-side
legs here.

## Leg (i) — New-stat sanity on a real vendor-kernel Rock 5B+

Confirm each new `device-stats` signal shows sane values on real hardware, and
capture the raw node path/mode/contents for the DDR and GPU probes to
confirm or extend the current candidate lists.

- [ ] `memory` (`memTotalBytes`, etc. from `/proc/meminfo`) reads plausible
      totals/used figures against `free -h` on the same board.
- [ ] `cpuFreq` (`/sys/devices/system/cpu/cpufreq/policy*`) reports one row per
      policy directory actually present on the board, `curKhz`/`maxKhz` both
      populated, and the policy `id` values match the directory names verbatim
      (no "big"/"little" relabeling).
- [ ] `ddr` — capture, verbatim, for the board under test:
  - which candidate under `/sys/class/devfreq` actually answered: the
    case-insensitive exact `dmc` match, or the pattern fallback
    (`/dmc/i` / `/dfi/i`, lexicographically sorted)?
  - the raw entry name (e.g. is it literally `dmc` on this board, or something
    else the fallback had to catch?)
  - whether a `load` node exists there at all, its raw contents (one of
    `"NN@FFFFFFFFHz"`, `"NN@FFFFFkHz"`, or bare `"NN"`), and its update cadence
    (how often does re-reading it change?)
  - `cur_freq` / `max_freq` raw contents and whether they agree with the
    `load` node's frequency echo (they are allowed to disagree; `cur_freq` is
    authoritative — record whether they ever do disagree on this board).
  - Use this capture to confirm or extend the DDR candidate list in
    `apps/backend/src/modules/system/collectors/ddr.ts`.
- [ ] `gpu` — capture, verbatim, for the board under test:
  - does `/sys/class/misc/mali0/device/` exist, and under which of
    `utilisation` / `utilization` / `gpu_busy_percent` does it actually
    answer (probed in that order)?
  - if the kbase path is absent, which devfreq entry matches `/\.gpu$/i`
    (confirm/deny that it is literally `fb000000.gpu`) and does that entry
    have a `load` node?
  - raw contents and cadence for whichever path answered.
  - Use this capture to confirm or extend the GPU candidate lists in
    `apps/backend/src/modules/system/collectors/gpu.ts`.
- [ ] Neither `ddr` nor `gpu` key is fabricated when its source is absent — verify
      by temporarily renaming/hiding the winning node and confirming the whole
      key disappears from the payload rather than reporting a fake `0`.

## Leg (ii) — Decode rows under a real decode load

- [ ] Start a real decode session on the board (vendor 6.1 kernel,
      `mpp-service` interface) and confirm `encoder-load`'s `decodeCores` array
      appears with one row per `*.rkvdec*` device the board actually has.
- [ ] Confirm the rows move (percentages change) while decode is active, and
      settle back down (or disappear per the "absent when idle" rule, if that is
      what the board does) once decode stops.
- [ ] Confirm a mainline/edge 7.1 image produces NO `decodeCores` key at all
      (the key must be absent, never an empty array) — this is the negative case
      and is just as important as the positive one.
- [ ] Confirm any `kind: "unavailable"` row keeps its slot (is not dropped) if
      the board reports fewer full percentages than decoder devices.

## Leg (iii) — Preview toggled to hardware

With `preview_hw_capability === true` on the board (RK3588's `mpph264enc`
descriptor) and the Preview disclosure's hardware toggle switched on:

- [ ] The engine reports hardware active: `status.preview_encoder_realized.mode
      === "hardware"` and `realized_element` names the hardware encoder
      (`mpph264enc`), with no `fallback_reason` present.
- [ ] **Concurrent utilization is observed across both encoder cores** during a
      main-stream + preview session (i.e. `encoder-load`'s two-slot `cores` array
      shows non-idle activity on both slots at the same time as the preview leg
      is active). This is a **utilization observation only** — record the two
      percentages and the timestamps they were sampled at. **Do NOT claim which
      physical core did which job** (no core-identity claim); the wire and UI
      surfaces this repo ships deliberately carry no such claim, and this leg
      must not introduce one either.
- [ ] Device CPU usage measurably drops when switching the same scene from
      software preview to hardware preview. Methodology to record:
  - keep the same source scene (identical resolution/framerate/content) across
    both preview modes, one after the other, with the main stream in the same
    state in both samples,
  - sample with `top -b -n <N> -d 1` (batch mode) over a fixed window (e.g. 30
    consecutive 1-second samples) once each mode has settled,
  - record the CeraUI backend process's and the cerastream engine process's
    CPU% for both windows, plus the raw `top -b` output as an attachment to the
    evidence file (NOT into this tracked doc — this doc records the
    methodology only, not any run's numeric outcome).
- [ ] Toggling back to software preview and confirming `mode === "software"`
      with `realized_element` naming the software encoder (`x264enc`) and no
      lingering `fallback_reason` from the prior hardware session.

## Leg (iv) — Fallback path on a board without the element

On a board/image where the `mpph264enc` GStreamer element is not installed
(e.g. an older `gstreamer1.0-rockchip1` build missing the plugin, or a
non-RK3588 board that nonetheless reports `preview_hw_capability === true` by
mistake — whichever is easiest to reproduce):

- [ ] Requesting hardware preview surfaces `fallback_reason.code ===
      "factory-missing"` on the wire, and the Preview disclosure renders the
      `preview-encode-fallback` warning row with the `factory-missing` message
      (no `preview-encode-fallback-property` row for this code — that field is
      only for `property-failure`).
- [ ] `preview_encoder_realized.mode` stays `"software"` for the whole session —
      confirm the fallback is silent-and-safe, not a crash or a stuck
      "Connecting…" state (the whole point of the typed reasons documented in
      the root `AGENTS.md` data-flow section).
- [ ] If reachable, also exercise `property-failure`: an installed element that
      rejects one of the declared static properties. Confirm
      `fallback_reason.property` names the exact rejected property (e.g. `bps`
      or `rc-mode`) and the fallback message row prints it verbatim.

## What this runbook deliberately does not cover

- Kernel driver correctness, core-affinity/binding proofs, or VEPU580 firmware
  behavior — sibling plan's board-qualification checklist (see cross-link
  above).
- Jetson or N100 preview-hardware paths — RK3588 is the only platform that
  currently publishes a preview-encoder descriptor (see
  `cerastream/AGENTS.md`).
- Any claim of which physical core (core 0 vs core 1) performed which job
  during concurrent encode+preview. CeraUI observes utilization per core
  *slot*, never core *identity*.
