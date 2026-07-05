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

/*
 * Real audio-device naming (T4). PURE module — no I/O, no side effects, no
 * imports of the effectful streaming graph. It turns the raw audio-card map into
 * a per-card human-readable label via a strict 3-tier fallback:
 *
 *   (1) the engine `list-devices` audio entry whose `alsa_card_id` join key
 *       matches the card AND whose `display_name` passes a human-name heuristic;
 *   (2) else the `/proc/asound/cards` longname for that card;
 *   (3) else the current alias/name (byte-identical fallback).
 *
 * Identical resolved labels are deduped with " (2)", " (3)" in STABLE card order.
 * The `config.asrc` wire keys are NEVER touched — only the display `label` is
 * produced here; pseudo-sources (`No audio`, `Pipeline default`) are label-free.
 */

/**
 * The engine-audio join record — a DEDICATED local type carrying ONLY the three
 * fields the label join needs. Deliberately NOT the `@ceraui/rpc` `CaptureDevice`
 * (which has no `alsa_card_id` join key), NOT the output of `fromEngineDevice()`
 * (drops the join key), and NOT the video-cache whitelist copy (copies 6 video
 * fields, not `alsa_card_id`). The `alsa_card_id?` field is the LOAD-BEARING join
 * key preserved verbatim from the `list-devices` audio entry — it is `undefined`
 * on the pre-T18 pin (whose binding `captureDeviceSchema` strips it) and populated
 * once the bumped binding retains it.
 */
export interface EngineAudioDevice {
	input_id: string;
	display_name: string;
	alsa_card_id?: string;
}

/**
 * Pseudo-source asrc ids — pipeline sentinels, not real cards. They never carry a
 * hardware label (they use an i18n `labelKey` instead), so `resolveAudioLabels`
 * skips them entirely.
 */
const PSEUDO_SOURCE_IDS = new Set(["No audio", "Pipeline default"]);

/**
 * Human-name heuristic guarding tier-1 (the engine `display_name`). The engine's
 * ALSA display_name quality is UNPROVEN (it comes from GStreamer's generic
 * `device.display_name()`, not necessarily the ALSA card name — see the T2
 * provenance note), so a junk value must lose to the `/proc/asound/cards`
 * longname. Rejects a value that:
 *   - contains no letter (e.g. "0", "  ");
 *   - is path-like (`/dev/…` or any absolute path, or an ALSA `hw:…` form);
 *   - is byte-identical to the card id itself (adds no information).
 */
export function isHumanAudioName(displayName: string, cardId: string): boolean {
	if (displayName.length === 0) return false;
	if (!/\p{L}/u.test(displayName)) return false; // must contain a letter
	if (displayName.startsWith("/")) return false; // path-like (`/dev/…`)
	if (/^hw:/i.test(displayName)) return false; // ALSA `hw:…` form
	if (displayName === cardId) return false; // byte-equal to the card id
	return true;
}

/**
 * Parse `/proc/asound/cards` into a `Map<cardId, longname>`. NEVER throws —
 * garbled / partial / empty input degrades to an empty (or partial) map, so the
 * `isRealDevice()`-gated read in the caller can pass whatever it got.
 *
 * The kernel format is two lines per card:
 * ```
 *  1 [Micro          ]: USB-Audio - RØDE AI-Micro
 *                       RØDE RØDE AI-Micro at usb-xhci-hcd.9.auto-1.4, high speed
 * ```
 * The bracketed short id on the header line is the ALSA card id (matches
 * `/sys/class/sound/cardN/id`); the indented continuation line is the longname.
 */
export function parseAsoundCards(text: string): Map<string, string> {
	const longnames = new Map<string, string>();
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (line === undefined) continue;
		const header = line.match(/^\s*\d+\s*\[([^\]]+)\]/);
		if (header === null) continue;
		const id = (header[1] ?? "").trim();
		const longname = (lines[i + 1] ?? "").trim();
		if (id.length > 0 && longname.length > 0) {
			longnames.set(id, longname);
		}
	}
	return longnames;
}

/** Resolve the RAW (pre-dedupe) label for one card via the 3-tier fallback. */
function resolveOneLabel(
	asrcKey: string,
	cardId: string,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
): string {
	// (1) engine-join: an audio entry whose join key matches this card AND whose
	//     display_name is a real human name (the heuristic rejects junk so the
	//     longname path below wins over a generic GStreamer label).
	const engineMatch = engineAudio.find(
		(d) =>
			d.alsa_card_id !== undefined &&
			d.alsa_card_id === cardId &&
			isHumanAudioName(d.display_name, cardId),
	);
	if (engineMatch !== undefined) return engineMatch.display_name;

	// (2) the `/proc/asound/cards` longname for that card.
	const longname = longnames.get(cardId);
	if (longname !== undefined && longname.length > 0) return longname;

	// (3) the current alias/name (byte-identical fallback — the map key IS the
	//     name currently shown, so `config.asrc` semantics are unchanged).
	return asrcKey;
}

/**
 * Resolve the display label for every DEVICE card, then dedupe identical labels
 * with " (2)", " (3)" in stable card order.
 *
 * @param cards       asrcKey → cardId (the live `audioDevices` map). Iteration
 *                    order is the caller's priority-sorted order and drives the
 *                    dedupe sequence; pseudo-sources are skipped (never labeled).
 * @param engineAudio the engine `list-devices` audio entries (join on
 *                    `alsa_card_id`); empty on the pre-T18 pin.
 * @param longnames   `/proc/asound/cards` cardId → longname (empty when the
 *                    read was skipped or failed).
 * @returns Map<asrcKey, label> for device cards only. An engine entry whose
 *          `alsa_card_id` matches no scanned card is never surfaced (no phantom
 *          entry — the result only ever contains keys from `cards`). The `cards`
 *          argument is never mutated.
 */
export function resolveAudioLabels(
	cards: Record<string, string>,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
): Map<string, string> {
	const labels = new Map<string, string>();
	const seenCounts = new Map<string, number>();
	for (const [asrcKey, cardId] of Object.entries(cards)) {
		if (PSEUDO_SOURCE_IDS.has(cardId)) continue;
		const raw = resolveOneLabel(asrcKey, cardId, engineAudio, longnames);
		const nextCount = (seenCounts.get(raw) ?? 0) + 1;
		seenCounts.set(raw, nextCount);
		labels.set(asrcKey, nextCount === 1 ? raw : `${raw} (${nextCount})`);
	}
	return labels;
}
