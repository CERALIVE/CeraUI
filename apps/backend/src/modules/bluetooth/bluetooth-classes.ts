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

/**
 * The device-class model (D1) — PURE.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * `audio-input` AND `scoCapable` ARE TWO DIFFERENT QUESTIONS
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * A registry row carries BOTH, and conflating them yields a source row that can
 * never open. `deviceClass: "audio-input"` answers "can this device be a source
 * of audio for the board at all"; `scoCapable` answers the much narrower "can
 * the board open its MICROPHONE over `PROFILE=sco`", which requires HFP or HSP
 * specifically.
 *
 * The A2DP-source-only device is the case that forces the split: a phone or a
 * wireless transmitter advertising ONLY `AudioSource` (`0000110a-…`) streams
 * audio to the board — genuinely an audio input — while exposing no SCO leg at
 * all. Deriving `scoCapable` from "has an audio UUID" would publish a
 * `PROFILE=sco` PCM for it, and every open of that PCM fails.
 *
 * The inverse also matters: an A2DP-SINK-only device (a speaker) is not an audio
 * input in either sense, so it stays `unknown` and never reaches a source list.
 *
 * `BluetoothDeviceClass` is deliberately an enum-shaped union with exactly two
 * members today. It is the EXTENSION POINT for future classes (HID, network) —
 * add a member here rather than growing a parallel boolean.
 */

/** The device classes CeraLive can act on. `unknown` is the honest floor. */
export type BluetoothDeviceClass = "audio-input" | "unknown";

/** Every class this build knows, for exhaustive rendering/testing. */
export const BLUETOOTH_DEVICE_CLASSES: readonly BluetoothDeviceClass[] = [
	"audio-input",
	"unknown",
];

/**
 * SCO-bearing service UUIDs — HFP and HSP, in both role directions.
 *
 * These, and ONLY these, make a device's microphone reachable over
 * `PROFILE=sco`. `1108`/`111e` are the headset/hands-free (HF) roles a headset
 * advertises; `1112`/`111f` are the gateway (AG) roles a phone advertises. A
 * remote AG is still a SCO peer, so it qualifies.
 */
const SCO_UUID_SHORT: ReadonlySet<string> = new Set([
	"1108", // Headset (HSP HS)
	"1112", // Headset Audio Gateway (HSP AG)
	"111e", // Handsfree (HFP HF)
	"111f", // Handsfree Audio Gateway (HFP AG)
]);

/**
 * A2DP source — the device streams audio TO the board.
 *
 * Sufficient for `audio-input`, never for `scoCapable`.
 */
const A2DP_SOURCE_SHORT = "110a";

/** A2DP sink — the device RECEIVES audio. Never an input on its own. */
const A2DP_SINK_SHORT = "110b";

/** The Bluetooth SIG base UUID suffix every 16-bit short UUID expands into. */
const SIG_BASE_SUFFIX = "-0000-1000-8000-00805f9b34fb";

/**
 * Reduce a service UUID to its 16-bit SIG short form, or `undefined` when it is
 * a vendor UUID that carries no SIG meaning.
 *
 * BlueZ publishes fully-expanded lowercase 128-bit UUIDs, but a fixture, a log
 * transcript, or a future BlueZ can carry the short form or upper case — so the
 * normalisation is explicit rather than a `startsWith` on one spelling. A UUID
 * outside the SIG base range is NOT folded to its first group: `0000110a-…-<a
 * different base>` is a different service that merely shares four digits.
 */
export function shortUuid(uuid: string): string | undefined {
	const value = uuid.trim().toLowerCase();
	if (value.length === 0) return undefined;

	if (/^[0-9a-f]{4}$/.test(value)) return value;

	if (
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
	) {
		if (!value.endsWith(SIG_BASE_SUFFIX)) return undefined;
		const group = value.slice(0, 8);
		// A SIG-based UUID's high half is always 0000; anything else is a
		// 32-bit allocation this build has no table for.
		if (!group.startsWith("0000")) return undefined;
		return group.slice(4);
	}

	return undefined;
}

/** Every SIG short UUID in `uuids`, de-duplicated, vendor UUIDs dropped. */
export function normalizeUuids(uuids: readonly string[]): string[] {
	const out: string[] = [];
	for (const raw of uuids) {
		const short = shortUuid(raw);
		if (short !== undefined && !out.includes(short)) out.push(short);
	}
	return out;
}

/** The derived capability pair every registry row carries. */
export interface BluetoothCapability {
	readonly deviceClass: BluetoothDeviceClass;
	/**
	 * TRUE only when the device advertises HFP or HSP — i.e. only when the board
	 * can actually open its microphone over `PROFILE=sco`. NEVER inferred from
	 * "the device has some audio UUID".
	 */
	readonly scoCapable: boolean;
}

/**
 * Derive the class pair from a device's advertised service UUIDs.
 *
 * A device with NO published UUIDs (BlueZ has not resolved its services yet, or
 * it is a bare advertisement) is `unknown` + `scoCapable:false`. Absence of
 * evidence is not evidence: claiming `audio-input` for an unresolved device
 * would put a row in a source list that may never be openable.
 */
export function deriveCapability(
	uuids: readonly string[],
): BluetoothCapability {
	const shorts = normalizeUuids(uuids);
	const scoCapable = shorts.some((u) => SCO_UUID_SHORT.has(u));
	const isA2dpSource = shorts.includes(A2DP_SOURCE_SHORT);

	return {
		deviceClass: scoCapable || isA2dpSource ? "audio-input" : "unknown",
		scoCapable,
	};
}

/** True when the device advertises A2DP sink and nothing that makes it an input. */
export function isPlaybackOnly(uuids: readonly string[]): boolean {
	const shorts = normalizeUuids(uuids);
	return (
		shorts.includes(A2DP_SINK_SHORT) &&
		!shorts.includes(A2DP_SOURCE_SHORT) &&
		!shorts.some((u) => SCO_UUID_SHORT.has(u))
	);
}
