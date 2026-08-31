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

// ONE CARD, TWO VOCABULARIES — and only this module relates them.
//
// CeraUI names an ALSA card by the KERNEL CARD ID it reads out of
// `/sys/class/sound/cardN/id` (`usbaudio`, `hdmirx`, `rk3588es8316`). That is the
// vocabulary of `config.asrc`, of the picker, and of every `hw:CARD=<id>` string
// this backend has ever handed the engine.
//
// The ENGINE names the same card by whatever its GStreamer device provider
// published, and the two agree only on the ALSA arm. Board-measured on a Rock 5B+
// running cerastream 2026.8.3 with `[audio] backend = "pipewire"`:
//
// | kernel `cardN/id` | engine `alsa_card_id`                    |
// |-------------------|------------------------------------------|
// | `usbaudio`        | `USB Audio`                              |
// | `hdmirx`          | `fddf8000.i2s-i2s-hifi i2s-hifi-0`       |
// | `rk3588es8316`    | `fe470000.i2s-ES8316 HiFi ES8316 HiFi-0` |
//
// Those right-hand values are the ALSA **PCM** ids — the first field of a
// `/proc/asound/pcm` row — not card ids. The PipeWire node proplist publishes no
// `api.alsa.card.id` at all (verified: zero occurrences in a full `pw-dump`), so
// the engine's candidate list falls through to `alsa.id`, which on a NODE is the
// PCM id. That is an engine defect and is recorded separately; this module is what
// lets CeraUI stay correct against an engine that has it.
//
// The join is DETERMINISTIC, never fuzzy: `/proc/asound/pcm` keys each PCM id by
// CARD INDEX, and `/sys/class/sound/cardN` gives that same index its card id. No
// name similarity, no prefix matching, no vendor table.
//
// It is also UNAMBIGUOUS, and that is a second property rather than a
// restatement of the first. A PCM id is not unique — two identical-model USB
// cards both report `USB Audio` — so a name resolves to a card only when exactly
// ONE card owns it. A shared name identifies nobody and is answered with nothing,
// because the alternative is picking whichever card was scanned first and
// attributing one device's audio to another's.
//
// Everything here is pure so the whole rule is testable with no sysfs and no
// engine.

import type { EngineAudioDevice } from "./audio-naming.ts";

/** A card's ALSA id plus every other name this board is known to call it. */
export type CardAliases = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * The PCM ids `/proc/asound/pcm` reports, keyed by ALSA CARD INDEX.
 *
 * Row shape is `<card>-<device>: <pcm id> : <pcm name> : <dir> <n>...`, e.g.
 * `01-00: USB Audio : USB Audio : capture 1`. A card can own several devices, so
 * the value is a set; a malformed row is skipped rather than failing the parse,
 * because this feeds a naming convenience and must never break the audio scan.
 */
export function parseProcAsoundPcm(
	text: string | undefined,
): ReadonlyMap<number, ReadonlySet<string>> {
	const byCard = new Map<number, Set<string>>();
	if (text === undefined) return byCard;
	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;
		const head = /^(\d+)-(\d+):\s*(.+)$/.exec(line);
		if (head === null) continue;
		const cardIndex = Number(head[1]);
		if (!Number.isInteger(cardIndex)) continue;
		// The remainder is ` : `-separated; the FIRST field is the PCM id, which is
		// the value the engine's PipeWire arm publishes as `alsa_card_id`.
		const pcmId = (head[3] ?? "").split(" : ")[0]?.trim() ?? "";
		if (pcmId === "") continue;
		const existing = byCard.get(cardIndex);
		if (existing === undefined) byCard.set(cardIndex, new Set([pcmId]));
		else existing.add(pcmId);
	}
	return byCard;
}

/** One scanned card, reduced to what an alias needs: its index and its id. */
export interface CardIndexAndId {
	readonly index: number;
	readonly id: string;
}

/**
 * Every name this board answers to for each card: its kernel card id, plus each
 * PCM id the kernel filed under that card's index.
 *
 * The card id is ALWAYS present, so a board with no readable `/proc/asound/pcm`
 * degrades to exactly the pre-existing single-name behaviour rather than losing
 * the card.
 */
export function buildCardAliases(
	cards: readonly CardIndexAndId[],
	pcmIdsByCardIndex: ReadonlyMap<number, ReadonlySet<string>>,
): CardAliases {
	const aliases = new Map<string, ReadonlySet<string>>();
	for (const card of cards) {
		const names = new Set<string>([card.id]);
		for (const pcmId of pcmIdsByCardIndex.get(card.index) ?? []) {
			names.add(pcmId);
		}
		aliases.set(card.id, names);
	}
	return aliases;
}

/**
 * Is `name` one of the names this board uses for `cardId`?
 *
 * MEMBERSHIP, not identity: several cards can answer to one name (see
 * `buildCardAliasOwners`), so this must never be used to decide WHICH card a
 * name refers to.
 */
export function isAliasOfCard(
	cardId: string,
	name: string,
	aliases: CardAliases,
): boolean {
	if (cardId === name) return true;
	return aliases.get(cardId)?.has(name) === true;
}

/**
 * The reverse index: each name this board answers to, mapped to the ONE card
 * that owns it — or `null` when more than one does.
 *
 * A PCM id is NOT unique. Two identical-model USB sound cards both report the
 * generic `USB Audio`, so that name names a PAIR; resolving it to whichever card
 * happens to come first attributes the second device to the first one's identity.
 * Recording the collision as `null` is what lets every consumer refuse instead.
 */
export function buildCardAliasOwners(
	aliases: CardAliases,
): ReadonlyMap<string, string | null> {
	const owners = new Map<string, string | null>();
	for (const [cardId, names] of aliases) {
		for (const name of names) {
			owners.set(name, owners.has(name) ? null : cardId);
		}
	}
	return owners;
}

/**
 * The card `name` PROVABLY refers to, or `undefined` when nothing does — which
 * covers both a name from no known vocabulary and a name several cards share.
 *
 * A kernel card id is checked first because it is unique by construction, so it
 * still identifies its own card even where some other card's PCM id collides
 * with it.
 */
function ownerOfName(
	name: string,
	aliases: CardAliases,
	owners: ReadonlyMap<string, string | null>,
): string | undefined {
	if (aliases.has(name)) return name;
	return owners.get(name) ?? undefined;
}

/**
 * The engine's OWN audio row for a card CeraUI names `cardId`, or `undefined`
 * when the engine lists nothing this board would call that card.
 *
 * Matched on `alsa_card_id` through the reverse index, so the kernel id (the
 * ALSA arm) and the PCM id (the PipeWire arm) both resolve — and neither is
 * guessed at. A row whose key names SEVERAL cards matches none of them: on the
 * PipeWire arm two identical USB cards share one PCM id, and answering either
 * with the first row would hand the second device the first one's identity.
 */
export function engineAudioDeviceForCard(
	cardId: string,
	engineAudio: readonly EngineAudioDevice[],
	aliases: CardAliases,
): EngineAudioDevice | undefined {
	const owners = buildCardAliasOwners(aliases);
	return engineAudio.find((device) => {
		const key = device.alsa_card_id;
		if (key === undefined) return false;
		// A card's own kernel id identifies it with no vocabulary at all, which is
		// what a board with an unreadable `/proc/asound/pcm` degrades to.
		if (key === cardId) return true;
		return ownerOfName(key, aliases, owners) === cardId;
	});
}

/**
 * The device string to hand the ENGINE for a card CeraUI names `cardId`.
 *
 * `audio.device` and `audio.meter_device` are both consumed by the engine, so
 * they must be spelled in the ENGINE's vocabulary — which is exactly what its own
 * `list-devices` `input_id` is. On the ALSA arm that string IS `hw:CARD=<kernel
 * card id>`, so this is byte-identical to the value it replaces; only an engine
 * that names the card differently produces a different one.
 *
 * FAIL-SOFT: a card the engine does not list, an engine that has not answered
 * yet, and an `input_id`-less row all fall back to the caller's own value. A
 * translation nobody can vouch for is never invented.
 */
export function engineAudioDeviceString(
	cardId: string,
	fallback: string,
	engineAudio: readonly EngineAudioDevice[],
	aliases: CardAliases,
): string {
	const match = engineAudioDeviceForCard(cardId, engineAudio, aliases);
	const inputId = match?.input_id;
	return inputId !== undefined && inputId.trim() !== "" ? inputId : fallback;
}

/**
 * Is a level the engine attributes to `reported` a reading of the card the
 * operator picked?
 *
 * TRI-STATE, and the third value is the whole point. `unknown` means the reported
 * identity is not a name this board relates to ANY of its cards, so nothing about
 * it can be proven in either direction — and a gate that cannot prove foreignness
 * must not suppress. Collapsing `unknown` into `foreign` is what made every single
 * selection report "Not the selected device" on the PipeWire arm, because the
 * engine's identity vocabulary is not this board's.
 */
export type MeterIdentityVerdict = "match" | "foreign" | "unknown";

/**
 * The card this board files `name` under, whichever of its vocabularies `name` is
 * drawn from — or `undefined` when it belongs to none of them (an opaque
 * `bluealsa:` PCM, an engine that named something this scan has never seen) and
 * equally when it belongs to SEVERAL of them.
 *
 * That second case is why the answer is not merely "the first card that claims
 * it": a shared PCM id canonicalises to nothing, so `classifyMeterIdentity`
 * reports `unknown` — which proves nothing and suppresses nothing — instead of
 * asserting a `foreign` mismatch it cannot support.
 */
export function canonicalCardId(
	name: string | undefined,
	aliases: CardAliases,
): string | undefined {
	if (name === undefined) return undefined;
	return ownerOfName(name, aliases, buildCardAliasOwners(aliases));
}

export function classifyMeterIdentity(
	preferredCardKey: string | undefined,
	reportedCardKey: string | undefined,
	aliases: CardAliases,
): MeterIdentityVerdict {
	// Both sides are canonicalised FIRST. Comparing raw keys would call a card
	// foreign whenever the two happened to be quoted in different vocabularies,
	// which is the whole defect, only narrower.
	const wanted = canonicalCardId(preferredCardKey, aliases);
	const reported = canonicalCardId(reportedCardKey, aliases);
	if (wanted === undefined || reported === undefined) return "unknown";
	return wanted === reported ? "match" : "foreign";
}
