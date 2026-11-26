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

import { realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readdirP } from "../../helpers/files.ts";
import { logger } from "../../helpers/logger.ts";
import { readTextFile } from "../../helpers/text-files.ts";

/**
 * The kernel's ALSA card class directory.
 *
 * Every card the kernel has registered appears here as a `cardN` entry owning an
 * `id` file and that card's PCM substream nodes — the shape the audio scan has
 * always read, and the only directory that can answer "what sound cards does
 * this board have".
 */
export const CANONICAL_SOUND_CLASS_DIR = "/sys/class/sound";

/** One ALSA card, as the sysfs class directory describes it. */
export interface ScannedAlsaCard {
	/** The card's ALSA id (`cardN/id`), e.g. `usbaudio`. */
	readonly id: string;
	/**
	 * The `N` of `cardN` — the only key that joins this card to a
	 * `/proc/asound/pcm` row, which is what `audio-card-vocabulary.ts` needs to
	 * relate it to the engine's own name for it. Every other shared field is a
	 * human-authored string, which is not an identity.
	 */
	readonly index: number;
	/** That card directory's entries — the PCM nodes the direction rules read. */
	readonly entries: readonly string[];
	/** USB vendor/product reported by the kernel, when readable. */
	readonly usbModel?: string;
}

/** Effectful surface, injected so a test drives the resolver without sysfs. */
export interface AlsaCardScanDeps {
	readDir: (path: string) => Promise<string[]>;
	readText: (path: string) => Promise<string | undefined>;
	resolveDevicePath?: (path: string) => Promise<string | undefined>;
}

const defaultScanDeps: AlsaCardScanDeps = {
	readDir: (path) => readdirP(path),
	readText: (path) => readTextFile(path),
	resolveDevicePath: (path) => realpath(path).catch(() => undefined),
};

/**
 * The `cardN` entries of a listing, in ALSA CARD-INDEX order.
 *
 * `readdir` answers in FILESYSTEM order, which is not an order at all — on ext4
 * with `dir_index` it is the filename hash, so one tree enumerates differently
 * on two machines and the card list inherits that. Sorted on the card INDEX
 * because that is the kernel's own ordering, and NUMERICALLY because a
 * lexicographic sort puts `card10` before `card2`.
 */
function cardIndex(entry: string): number {
	const parsed = Number(entry.slice("card".length));
	return Number.isInteger(parsed) ? parsed : Number.NaN;
}

function cardEntriesInIndexOrder(entries: readonly string[]): string[] {
	return entries
		.filter((entry) => entry.startsWith("card"))
		.sort((a, b) => {
			const [ai, bi] = [cardIndex(a), cardIndex(b)];
			if (Number.isNaN(ai) || Number.isNaN(bi)) return a.localeCompare(b);
			return ai - bi;
		});
}

// A card can disappear mid-scan (hotplug); an unreadable card directory reports
// no entries rather than aborting the whole audio refresh.
async function readCardEntries(
	path: string,
	deps: AlsaCardScanDeps,
): Promise<string[]> {
	try {
		return await deps.readDir(path);
	} catch {
		return [];
	}
}

async function readAudioUsbModel(
	card: string,
	deps: AlsaCardScanDeps,
): Promise<string | undefined> {
	// Resolve the class link before walking from the interface to the nearest USB device.
	const device = await deps.resolveDevicePath?.(join(card, "device"));
	for (let dir = device; dir !== undefined && dir !== "/"; dir = dirname(dir)) {
		const info = await deps.readText(join(dir, "uevent"));
		if (!info?.split("\n").includes("DEVTYPE=usb_device")) continue;
		const product = /^PRODUCT=([\da-f]{1,4})\/([\da-f]{1,4})\//im.exec(info);
		const vid = product?.[1]?.toLowerCase().padStart(4, "0");
		const pid = product?.[2]?.toLowerCase().padStart(4, "0");
		return vid && pid ? `${vid}:${pid}` : undefined;
	}
	return undefined;
}

/**
 * The ALSA cards a directory describes, read VERBATIM — no reconciliation.
 *
 * A `cardN` entry counts only once its `id` reads back non-empty: that file is
 * what makes an entry a card rather than a name that merely starts with "card",
 * and an id-less row could never be selected anyway.
 *
 * An ABSENT directory is an empty board, not a fault (the pre-existing rule — a
 * dev host has no sound tree at all). Any other error (`ENOTDIR`, `EACCES`) is a
 * real misconfiguration and stays loud.
 */
export async function scanAlsaCards(
	dir: string,
	deps: AlsaCardScanDeps = defaultScanDeps,
): Promise<ScannedAlsaCard[]> {
	let entries: string[];
	try {
		entries = await deps.readDir(dir);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
		return [];
	}

	const cards: ScannedAlsaCard[] = [];
	for (const entry of cardEntriesInIndexOrder(entries)) {
		const path = join(dir, entry);
		const id = ((await deps.readText(join(path, "id"))) ?? "").trim();
		if (id === "") continue;
		const usbModel = await readAudioUsbModel(path, deps);
		cards.push({
			id,
			index: cardIndex(entry),
			entries: await readCardEntries(path, deps),
			...(usbModel === undefined ? {} : { usbModel }),
		});
	}
	return cards;
}

/** The directory the last resolution settled on, so the warn fires once. */
let lastResolvedDir: string | undefined;

/** Forget the last resolution (test isolation). */
export function resetAlsaCardScanResolution(): void {
	lastResolvedDir = undefined;
}

/** The directory the last resolution actually scanned, or `undefined`. */
export function getResolvedAlsaCardDir(): string | undefined {
	return lastResolvedDir;
}

/**
 * The board's ALSA cards, reconciling `setup.sound_device_dir` against the
 * kernel's own card directory.
 *
 * `setup.json` is a STATIC value packaged verbatim into the `ceralive-device`
 * `.deb` — the same independently-versioned artifact `warnOnHardwareIdentityDrift`
 * exists for. The audio scan reads it as a sysfs CLASS directory (`cardN/id`,
 * `cardN/pcmC<N>D<M>c`), so a value naming any other layout yields ZERO cards and
 * the picker collapses to its two pipeline pseudo-sources — indistinguishable
 * from a board with no sound hardware at all.
 *
 * That is not hypothetical. Board-confirmed on a Rock 5B+ running current CeraUI
 * against `ceralive-device 2026.7.2-20260719T181141`, whose packaged `setup.json`
 * still carries the pre-#166 `"sound_device_dir": "/dev/snd"`. `/dev/snd` holds
 * ALSA's DEVICE NODES (`controlC0`, `pcmC0D0c`, `timer`) and no `cardN`
 * directory whatsoever, so a connected, capture-ready RØDE HDMI-to-USB-C —
 * `0 [usbaudio]: USB-Audio - RØDE HDMI to USB-C`, `00-00: USB Audio : capture 1`
 * — was absent from `audio_sources` entirely, with nothing in the operator's UI
 * to say why. The engine's own audio enumeration was correct throughout; the loss
 * was entirely in this scan. Fixing `setup.json` (PR #166 already did) only
 * reaches a device on the NEXT full `.deb` upgrade, so the code has to survive
 * the disagreement in the meantime.
 *
 * The reconciliation is POSITIVE-EVIDENCE-ONLY, which is what keeps it safe:
 *
 * - A configured directory that names at least one card ANSWERS, unreconciled.
 * - A configured directory that is already the canonical one has nothing to fall
 *   back to.
 * - Otherwise the configured directory read cleanly and named no card, which is
 *   a statement about the PATH and never about the hardware — so the canonical
 *   directory is asked, and answers only if IT names cards. A board that
 *   genuinely has none is byte-identical to before this existed.
 *
 * The rescue scan can never throw: it runs to recover from a bad configuration,
 * so it must not turn one fault into another.
 */
export async function resolveConfiguredAlsaCards(
	configuredDir: string,
	deps: AlsaCardScanDeps = defaultScanDeps,
): Promise<ScannedAlsaCard[]> {
	const configured = await scanAlsaCards(configuredDir, deps);
	if (configured.length > 0 || configuredDir === CANONICAL_SOUND_CLASS_DIR) {
		lastResolvedDir = configuredDir;
		return configured;
	}

	const canonical = await scanAlsaCards(CANONICAL_SOUND_CLASS_DIR, deps).catch(
		() => [] as ScannedAlsaCard[],
	);
	if (canonical.length === 0) {
		lastResolvedDir = configuredDir;
		return configured;
	}

	if (lastResolvedDir !== CANONICAL_SOUND_CLASS_DIR) {
		logger.warn(
			"audio: setup.sound_device_dir names no ALSA card — falling back to the kernel's card directory",
			{
				configured: configuredDir,
				resolved: CANONICAL_SOUND_CLASS_DIR,
				cards: canonical.map((card) => card.id),
			},
		);
	}
	lastResolvedDir = CANONICAL_SOUND_CLASS_DIR;
	return canonical;
}
