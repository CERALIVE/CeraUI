/*
    CeraUI - web UI for the CERALIVE project
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
 * How a Bluetooth microphone row renders. Pure and rune-free, so every rule is
 * testable without mounting Svelte.
 */

import type { AudioSource } from "@ceraui/rpc/schemas";

/**
 * A row is Bluetooth because the BACKEND said so — never because its id happens
 * to start with a prefix. `transport` is the engine-sourced field the External
 * badge already trusts, so the two can never disagree about what a row is.
 */
export function isBluetoothAudioSource(entry: AudioSource): boolean {
	return entry.kind === "device" && entry.transport === "bluetooth";
}

/** A row that is LISTED but cannot be selected, with the reason the device gave. */
export function audioSourceUnavailableReasonKey(
	entry: AudioSource,
): string | undefined {
	if (entry.unavailable_reason === undefined) return undefined;
	return `live.source.audioUnavailable.${entry.unavailable_reason}`;
}

/**
 * The longer sentence behind the short refusal label, for the row's tooltip.
 *
 * Derived from the SAME `unavailable_reason` token rather than by rewriting the
 * short key's string: a key built by patching another key breaks silently the
 * moment either name changes, and this pair has to stay in lockstep across all
 * ten catalogs.
 */
export function audioSourceUnavailableHintKey(
	entry: AudioSource,
): string | undefined {
	if (entry.unavailable_reason === undefined) return undefined;
	return `live.source.audioUnavailableHint.${entry.unavailable_reason}`;
}

export interface AudioQualityChip {
	/** The i18n key to render. */
	readonly key: string;
	/** Params for a NEGOTIATED reading; absent for the ceiling form. */
	readonly params?: { readonly khz: string };
	/** `negotiated` when the device reported a codec, `ceiling` when it did not. */
	readonly kind: "negotiated" | "ceiling";
	readonly codec?: string;
}

/**
 * The quality chip for a Bluetooth microphone row.
 *
 * A reported codec yields the NEGOTIATED reading — CVSD is narrowband, mSBC is
 * HFP 1.6 wideband — rendered as its real rate. With no codec reported the chip
 * falls back to the CEILING ("up to 16 kHz mono"), which is a bound rather than
 * a claim: SCO cannot exceed it, and asserting a specific rate the device never
 * negotiated would be the same fabrication as rendering a busy/idle encoder core
 * as a percentage.
 *
 * A mono-only transport is stated in the copy rather than interpolated, so no
 * locale has to compose a channel count.
 */
export function audioQualityChip(
	entry: AudioSource,
): AudioQualityChip | undefined {
	if (!isBluetoothAudioSource(entry)) return undefined;
	const quality = entry.quality;
	if (quality === undefined) {
		return { key: "live.source.audioQualityCeiling", kind: "ceiling" };
	}
	return {
		key: "live.source.audioQualityNegotiated",
		params: { khz: formatKilohertz(quality.sample_rate_hz) },
		kind: "negotiated",
		codec: quality.codec,
	};
}

/**
 * Hertz as a bare kilohertz figure. Integer kHz render without a decimal point
 * so an 8000 Hz narrowband link reads `8`, not `8.0`.
 */
function formatKilohertz(hz: number): string {
	const khz = hz / 1000;
	return Number.isInteger(khz) ? String(khz) : khz.toFixed(1);
}
