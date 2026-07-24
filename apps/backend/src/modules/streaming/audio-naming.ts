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
 * Real audio-device naming (T4). Resolution is PURE — no I/O, no imports of the
 * effectful streaming graph. It turns the raw audio-card map into a per-card
 * human-readable label via a strict 4-tier fallback:
 *
 *   (0) an operator-assigned alias from `config.audio_device_aliases`, keyed on
 *       the card's STABLE identity (`stable_id`, else `card:<alsaCardId>`);
 *   (1) the engine `list-devices` audio entry whose `alsa_card_id` join key
 *       matches the card AND whose `display_name` passes a human-name heuristic;
 *   (2) else the `/proc/asound/cards` longname for that card;
 *   (3) else the current alias/name (byte-identical fallback).
 *
 * Tiers 1 and 2 both yield RAW device strings — on Linux both are literally the
 * ALSA longname (`sound/usb/card.c` appends " at usb-<bus>-<path>, <speed> speed"
 * to "<manufacturer> <product>"), and cerastream sets `display_name` to that same
 * longname. They are therefore run through `cleanAudioDeviceName()` before being
 * shown; the untouched raw string is preserved as the display `detail` so the
 * bus path / link speed / full legal manufacturer name stay available for
 * diagnostics. Tiers 0 and 3 are curated strings and are never rewritten.
 *
 * Identical resolved labels are deduped with " (2)", " (3)" in STABLE card order.
 * The `config.asrc` wire keys are NEVER touched — only the display `label` is
 * produced here; pseudo-sources (`No audio`, `Pipeline default`) are label-free.
 *
 * The ONE deliberate side effect (Task 21): when the tier-3 alias fallback fires
 * for a `usbaudio`-family card — i.e. BOTH the engine join and the longname
 * missed — a single `logger.info` diagnostic is emitted per card per boot (see
 * `logAliasTierMiss`), so an on-device `LOG_LEVEL` capture can root-cause a
 * generic "USB audio" fallback for a named dongle. It never logs per-tick (a
 * module-level dedup Set) and never at warn/error (a nameless card is normal).
 */

import { logger } from "../../helpers/logger.ts";

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
	product_name?: string;
	transport?: AudioDeviceTransport;
	stable_id?: string;
}

export type AudioDeviceTransport = "usb" | "hdmi" | "bluetooth" | "onboard";

export interface AudioDeviceIdentity {
	product_name?: string;
	transport?: AudioDeviceTransport;
	stable_id?: string;
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

// Anchored on the `usbaudio` prefix so a kernel-suffixed duplicate (`usbaudio_1`)
// is still caught; the generic USB audio-class card enumerates as `usbaudio`.
const USB_AUDIO_FAMILY_RE = /^usbaudio/i;

/**
 * The kernel's USB-audio longname suffix: `sound/usb/card.c` appends
 * `" at usb-<bus_name>-<devpath>, <speed> speed"` to the card longname. Anchored
 * on the trailing `speed` word so a product name that merely CONTAINS " at " is
 * never truncated — only the kernel-generated diagnostic tail matches.
 */
const ALSA_BUS_SUFFIX_RE = /\s+at\s+\S+,\s*[^,]*\bspeed\s*$/i;

/**
 * Corporate-entity filler tokens. Used ONLY to bridge a repeated manufacturer
 * token: `"DJI Technology Co., Ltd. DJI MIC MINI"` → the leading `DJI` reappears
 * with nothing but legal boilerplate in between, so the boilerplate run and the
 * duplicate are dropped together. A token outside this set BLOCKS the collapse,
 * so a genuine product name that happens to repeat a word ("Blue Microphones
 * Yeti Blue") is left alone.
 */
const CORPORATE_FILLER = new Set([
	"co",
	"company",
	"corp",
	"corporation",
	"electronic",
	"electronics",
	"gmbh",
	"inc",
	"incorporated",
	"international",
	"limited",
	"llc",
	"ltd",
	"plc",
	"pte",
	"sa",
	"sarl",
	"sas",
	"tech",
	"technologies",
	"technology",
]);

function normalizeToken(token: string): string {
	// Strip trailing/leading punctuation so `Co.,` and `Ltd.` compare as words.
	return token.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
}

/**
 * Drop a manufacturer name that is repeated as a prefix of the product string.
 * Two shapes are collapsed, both keyed on the FIRST token reappearing later:
 *   - an immediate repeat — `"RØDE RØDE HDMI to USB-C"` → `"RØDE HDMI to USB-C"`;
 *   - a repeat separated only by corporate filler — `"DJI Technology Co., Ltd.
 *     DJI MIC MINI"` → `"DJI MIC MINI"`.
 * Anything else is returned verbatim. Comparison is case-insensitive and
 * punctuation-insensitive; the SURVIVING occurrence keeps its original casing.
 */
function dedupeManufacturerPrefix(name: string): string {
	const tokens = name.split(/\s+/).filter((t) => t.length > 0);
	if (tokens.length < 2) return name;
	const head = normalizeToken(tokens[0] ?? "");
	if (head.length === 0) return name;
	for (let i = 1; i < tokens.length - 1; i++) {
		if (normalizeToken(tokens[i] ?? "") !== head) continue;
		// Everything between the two occurrences must be corporate filler (an
		// immediate repeat, i === 1, has an empty in-between run and passes).
		const bridged = tokens
			.slice(1, i)
			.every((t) => CORPORATE_FILLER.has(normalizeToken(t)));
		if (!bridged) break;
		return tokens.slice(i).join(" ");
	}
	return name;
}

/** The operator-facing name plus the raw string it was derived from. */
export interface CleanedAudioName {
	/** The cleaned, operator-facing name. */
	name: string;
	/**
	 * The untouched source string, present ONLY when cleaning changed it — the
	 * bus path, link speed, and full legal manufacturer name live here so the
	 * diagnostic value is moved to a secondary surface, never deleted.
	 */
	detail?: string;
}

/**
 * Turn a RAW ALSA/engine device string into an operator-facing name: strip the
 * kernel's `" at <bus-path>, <speed> speed"` diagnostic suffix, then drop a
 * manufacturer name duplicated as the product prefix. Idempotent, never throws,
 * and returns the input unchanged (with no `detail`) when nothing matched.
 */
export function cleanAudioDeviceName(raw: string): CleanedAudioName {
	const trimmed = raw.trim().replace(/\s+/g, " ");
	const withoutSuffix = trimmed.replace(ALSA_BUS_SUFFIX_RE, "").trim();
	const base = withoutSuffix.length > 0 ? withoutSuffix : trimmed;
	const name = dedupeManufacturerPrefix(base).trim();
	if (name.length === 0 || name === trimmed) return { name: trimmed };
	return { name, detail: trimmed };
}

/**
 * The rename key for a card: the engine's reboot-stable hardware identity when
 * it published one, else the ALSA card id namespaced as `card:<id>`. NEVER the
 * volatile USB bus path — that changes on replug/reboot. The engine's own
 * card-derived `stable_id` already uses the `card:` form, so the two agree for a
 * card with no richer identity.
 */
export function audioAliasKey(cardId: string, stableId?: string): string {
	return stableId !== undefined && stableId.length > 0
		? stableId
		: `card:${cardId}`;
}

const loggedTierMissCardIds = new Set<string>();

/**
 * Clear the per-boot tier-miss diagnostic dedup set (public seam). Called from
 * `resetMockState()` for per-test isolation and safe to call at boot.
 */
export function resetAudioNamingDiagnostics(): void {
	loggedTierMissCardIds.clear();
}

// Mirrors the isHumanAudioName rejection checks to NAME the failing one for the
// diagnostic; must stay in lock-step but never changes isHumanAudioName behavior.
function humanAudioNameRejectReason(
	displayName: string,
	cardId: string,
): string | null {
	if (displayName.length === 0) return "empty";
	if (!/\p{L}/u.test(displayName)) return "no-letter";
	if (displayName.startsWith("/")) return "path-like";
	if (/^hw:/i.test(displayName)) return "alsa-hw-form";
	if (displayName === cardId) return "equals-card-id";
	return null;
}

// One-shot tier-3 diagnostic (Task 21): ONE info line per usbaudio-family cardId
// per boot when the alias fallback fires. info-level only — a nameless card is
// normal. `engineEntriesWithoutJoinKey` surfaces the pre-T18 stripped-key cause.
function logAliasTierMiss(
	cardId: string,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
): void {
	if (!USB_AUDIO_FAMILY_RE.test(cardId)) return;
	if (loggedTierMissCardIds.has(cardId)) return;
	loggedTierMissCardIds.add(cardId);

	const engineEntry = engineAudio.find((d) => d.alsa_card_id === cardId);
	const longname = longnames.get(cardId);

	logger.info(
		"audio-naming tier-3 alias fallback: engine join AND /proc/asound/cards longname both missed for a usbaudio-family card; rendering the generic alias",
		{
			module: "audio-naming",
			cardId,
			engineEntryPresent: engineEntry !== undefined,
			heuristicRejectReason:
				engineEntry !== undefined
					? humanAudioNameRejectReason(engineEntry.display_name, cardId)
					: null,
			longnamePresent: longname !== undefined && longname.length > 0,
			engineEntriesWithoutJoinKey: engineAudio.filter(
				(d) => d.alsa_card_id === undefined,
			).length,
		},
	);
}

/** The operator-facing presentation of one audio card. */
export interface AudioDeviceDisplay {
	/** The name shown in the picker (already deduped with " (2)" when needed). */
	label: string;
	/** The raw hardware descriptor behind `label` — bus path, speed, legal name. */
	detail?: string;
	/** Stable rename key — see `audioAliasKey`. */
	aliasKey: string;
	/** The operator-assigned name, when one is set for `aliasKey`. */
	alias?: string;
}

function resolveOneDisplay(
	asrcKey: string,
	cardId: string,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
	aliases: Readonly<Record<string, string>>,
): Omit<AudioDeviceDisplay, "label"> & { raw: string } {
	const engineMatch = engineAudio.find(
		(d) => d.alsa_card_id !== undefined && d.alsa_card_id === cardId,
	);
	const aliasKey = audioAliasKey(cardId, engineMatch?.stable_id);
	const hardware = resolveHardwareName(
		asrcKey,
		cardId,
		engineMatch,
		engineAudio,
		longnames,
	);

	// (0) an operator rename wins outright — it is an explicit override, and it is
	//     keyed on stable identity so it survives a replug/reboot renumber. The
	//     hardware name it replaces falls back to `detail` so it is never lost.
	const alias = aliases[aliasKey]?.trim();
	if (alias !== undefined && alias.length > 0) {
		return {
			raw: alias,
			aliasKey,
			alias,
			detail: hardware.detail ?? hardware.name,
		};
	}

	return {
		raw: hardware.name,
		aliasKey,
		...(hardware.detail !== undefined ? { detail: hardware.detail } : {}),
	};
}

/** Tiers 1-3 of the ladder: the hardware-derived name, with tiers 1-2 cleaned. */
function resolveHardwareName(
	asrcKey: string,
	cardId: string,
	engineMatch: EngineAudioDevice | undefined,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
): CleanedAudioName {
	// (1) engine-join: an audio entry whose join key matches this card. Prefer the
	//     real `product_name` (cerastream Todo 20), then the generic `display_name`
	//     — but each ONLY if it passes the human-name heuristic. The heuristic
	//     rejects a value equal to the card id ("usbaudio"), so a generic engine
	//     product_name never beats the longname path below (which carries the real
	//     "RØDE …" name for a device the engine mislabels generically).
	if (
		engineMatch?.product_name !== undefined &&
		isHumanAudioName(engineMatch.product_name, cardId)
	) {
		return cleanAudioDeviceName(engineMatch.product_name);
	}
	// cerastream sets an audio entry's `display_name` to the ALSA longname
	// verbatim, so this tier carries the same kernel diagnostic tail as tier 2.
	if (
		engineMatch !== undefined &&
		isHumanAudioName(engineMatch.display_name, cardId)
	) {
		return cleanAudioDeviceName(engineMatch.display_name);
	}

	// (2) the `/proc/asound/cards` longname for that card.
	const longname = longnames.get(cardId);
	if (longname !== undefined && longname.length > 0) {
		return cleanAudioDeviceName(longname);
	}

	// (3) the current alias/name (byte-identical fallback — the map key IS the
	//     name currently shown, so `config.asrc` semantics are unchanged).
	logAliasTierMiss(cardId, engineAudio, longnames);
	return { name: asrcKey };
}

/**
 * Resolve the full display model for every DEVICE card, deduping identical
 * labels with " (2)", " (3)" in stable card order.
 *
 * @param cards       asrcKey → cardId (the live `audioDevices` map). Iteration
 *                    order is the caller's priority-sorted order and drives the
 *                    dedupe sequence; pseudo-sources are skipped (never labeled).
 * @param engineAudio the engine `list-devices` audio entries (join on
 *                    `alsa_card_id`); empty on the pre-T18 pin.
 * @param longnames   `/proc/asound/cards` cardId → longname (empty when the
 *                    read was skipped or failed).
 * @param aliases     operator renames from `config.audio_device_aliases`, keyed
 *                    on `audioAliasKey`.
 * @returns Map<asrcKey, display> for device cards only. An engine entry whose
 *          `alsa_card_id` matches no scanned card is never surfaced (no phantom
 *          entry — the result only ever contains keys from `cards`). Neither
 *          argument is mutated.
 */
export function resolveAudioDisplays(
	cards: Record<string, string>,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
	aliases: Readonly<Record<string, string>> = {},
): Map<string, AudioDeviceDisplay> {
	const displays = new Map<string, AudioDeviceDisplay>();
	const seenCounts = new Map<string, number>();
	for (const [asrcKey, cardId] of Object.entries(cards)) {
		if (PSEUDO_SOURCE_IDS.has(cardId)) continue;
		const { raw, ...rest } = resolveOneDisplay(
			asrcKey,
			cardId,
			engineAudio,
			longnames,
			aliases,
		);
		const nextCount = (seenCounts.get(raw) ?? 0) + 1;
		seenCounts.set(raw, nextCount);
		displays.set(asrcKey, {
			label: nextCount === 1 ? raw : `${raw} (${nextCount})`,
			...rest,
		});
	}
	return displays;
}

/** Label-only projection of {@link resolveAudioDisplays}. */
export function resolveAudioLabels(
	cards: Record<string, string>,
	engineAudio: readonly EngineAudioDevice[],
	longnames: Map<string, string>,
	aliases: Readonly<Record<string, string>> = {},
): Map<string, string> {
	const labels = new Map<string, string>();
	for (const [asrcKey, display] of resolveAudioDisplays(
		cards,
		engineAudio,
		longnames,
		aliases,
	)) {
		labels.set(asrcKey, display.label);
	}
	return labels;
}

/**
 * Resolve the stable-identity metadata (`product_name` / `transport` /
 * `stable_id`, cerastream Todo 20) for every DEVICE card, joining the engine
 * `list-devices` audio entries on `alsa_card_id`. A card with no matching engine
 * entry — or an engine on the pre-2026.7.3 pin that strips the fields — yields no
 * entry, so the frontend falls back to the plain label. Pseudo-sources are
 * skipped. The `cards` argument is never mutated.
 */
export function resolveAudioIdentities(
	cards: Record<string, string>,
	engineAudio: readonly EngineAudioDevice[],
): Map<string, AudioDeviceIdentity> {
	const identities = new Map<string, AudioDeviceIdentity>();
	for (const [asrcKey, cardId] of Object.entries(cards)) {
		if (PSEUDO_SOURCE_IDS.has(cardId)) continue;
		const match = engineAudio.find(
			(d) => d.alsa_card_id !== undefined && d.alsa_card_id === cardId,
		);
		if (match === undefined) continue;
		// Only surface a product_name that passes the human-name heuristic, so a
		// generic engine value (e.g. "usbaudio", equal to the card id) is never
		// composed as `<Product Name> · <Transport>` — the transport tag still
		// rides on its own, and the picker falls back to the longname-derived label.
		const hasRealProduct =
			match.product_name !== undefined &&
			isHumanAudioName(match.product_name, cardId);
		const identity: AudioDeviceIdentity = {
			...(hasRealProduct ? { product_name: match.product_name } : {}),
			...(match.transport !== undefined ? { transport: match.transport } : {}),
			...(match.stable_id !== undefined ? { stable_id: match.stable_id } : {}),
		};
		if (Object.keys(identity).length > 0) identities.set(asrcKey, identity);
	}
	return identities;
}
