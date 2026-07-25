/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/*
 * Static, code-level display names for ONBOARD (non-pluggable) capture blocks.
 *
 * A pluggable accessory publishes a real product name that only needs CLEANING
 * (see `audio-naming.ts` `cleanAudioDeviceName`). An SoC block does not: its only
 * hardware string is a raw kernel driver id — `rk_hdmirx` for the RK3588 HDMI-RX
 * video node, `rockchip,hdmiin` for the same block's ALSA card — and there is
 * nothing human in it to recover. The name is therefore a RULE that ships with
 * the app, keyed on that driver id.
 *
 * It is deliberately NOT an operator-writable alias: there is no UI, no RPC, and
 * no config field for device naming anywhere in CeraUI (#207). Adding a board is
 * a code change, reviewed like any other source change.
 *
 * `normalizeOnboardKey` folds punctuation and case, so ONE entry matches every
 * spelling of the same block — `rk_hdmirx` (the engine `display_name`),
 * `stream_hdmirx` (the sysfs `Card type` the engine-down v4l2 scan reads on a
 * ROCK 5B+), `rockchip,hdmirx-controller` (the device-tree compatible), and the
 * ALSA card id `rockchiphdmiin` alike. It is shared with the audio ladder's
 * `ONBOARD_AUDIO_DISPLAY_RULES` so both media types fold keys identically.
 */

/** Fold a raw hardware string to its rule key: letters + digits, lowercased. */
export function normalizeOnboardKey(value: string): string {
	return value.replace(/[^\p{L}\p{N}]+/gu, "").toLowerCase();
}

/**
 * Static display names for ONBOARD VIDEO capture nodes, keyed by
 * {@link normalizeOnboardKey}.
 *
 * `HDMI Input` is deliberately the SAME name the audio ladder gives
 * `rockchip,hdmiin` — the two are the video and audio halves of ONE physical
 * HDMI port, so naming them differently would invent a distinction the hardware
 * does not have.
 */
const ONBOARD_VIDEO_DISPLAY_RULES: ReadonlyMap<string, string> = new Map([
	["rkhdmirx", "HDMI Input"],
	["streamhdmirx", "HDMI Input"],
	["rockchiphdmirx", "HDMI Input"],
	["rockchiphdmirxcontroller", "HDMI Input"],
]);

/**
 * The static onboard display name for a video node, or `undefined` when the raw
 * string is not a known onboard driver id (every pluggable device, which keeps
 * its real product name).
 */
export function resolveOnboardVideoDisplayName(
	rawName: string,
): string | undefined {
	return ONBOARD_VIDEO_DISPLAY_RULES.get(normalizeOnboardKey(rawName));
}

/**
 * The operator-facing name for a video node: the static onboard rule when one
 * matches, else the raw string untouched. Idempotent — a already-resolved name
 * is not itself a rule key, so re-applying is a no-op.
 */
export function applyOnboardVideoDisplayRule(rawName: string): string {
	return resolveOnboardVideoDisplayName(rawName) ?? rawName;
}
