import {
	afterAll,
	afterEach,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	type AlsaCardScanDeps,
	CANONICAL_SOUND_CLASS_DIR,
	getResolvedAlsaCardDir,
	resetAlsaCardScanResolution,
	resolveConfiguredAlsaCards,
	scanAlsaCards,
} from "../modules/streaming/alsa-card-scan.ts";
import {
	deriveAudioSources,
	getAudioCaptureCardIds,
	getAudioDevices,
	isPlaybackOnlyCard,
	setMockAudioDevicesProvider,
	updateAudioDevices,
} from "../modules/streaming/audio.ts";

interface CardFixture {
	dir: string;
	id: string;
	entries?: string[];
}

/**
 * The Rock 5B+ this bug was reported on, reproduced verbatim from its own
 * `/sys/class/sound` + `/proc/asound/pcm`: the RØDE capture card, the onboard
 * analog codec (both directions), and the two HDMI OUTPUT cards.
 */
const BOARD_CARDS: readonly CardFixture[] = [
	{ dir: "card0", id: "usbaudio", entries: ["controlC0", "id", "pcmC0D0c"] },
	{
		dir: "card1",
		id: "rk3588es8316",
		entries: ["controlC1", "id", "pcmC1D0c", "pcmC1D0p"],
	},
	{ dir: "card2", id: "hdmi0", entries: ["controlC2", "id", "pcmC2D0p"] },
	{ dir: "card3", id: "hdmi1", entries: ["controlC3", "id", "pcmC3D0p"] },
];

/** The board's `/dev/snd`: ALSA DEVICE NODES, and not one `cardN` directory. */
const DEV_SND_ENTRIES: readonly string[] = [
	"by-id",
	"by-path",
	"controlC0",
	"controlC1",
	"pcmC0D0c",
	"pcmC1D0c",
	"pcmC1D0p",
	"timer",
];

const roots: string[] = [];

async function makeCardTree(cards: readonly CardFixture[]): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-alsa-scan-"));
	roots.push(root);
	for (const card of cards) {
		await mkdir(join(root, card.dir));
		await writeFile(join(root, card.dir, "id"), `${card.id}\n`);
		for (const entry of card.entries ?? []) {
			if (entry === "id") continue;
			await mkdir(join(root, card.dir, entry));
		}
	}
	return root;
}

/** Scan deps that answer for a fake `/dev/snd` and a fake canonical tree. */
function driftDeps(canonicalRoot: string | undefined): {
	deps: AlsaCardScanDeps;
	reads: string[];
} {
	const reads: string[] = [];
	const real = scanDepsFor(canonicalRoot);
	return {
		reads,
		deps: {
			readDir: async (path) => {
				reads.push(path);
				if (path === "/dev/snd") return [...DEV_SND_ENTRIES];
				if (path.startsWith("/dev/snd/")) {
					const err = new Error("ENOENT") as Error & { code: string };
					err.code = "ENOENT";
					throw err;
				}
				return real.readDir(path);
			},
			readText: async (path) => {
				reads.push(path);
				return real.readText(path);
			},
		},
	};
}

function scanDepsFor(canonicalRoot: string | undefined): AlsaCardScanDeps {
	const remap = (path: string): string =>
		canonicalRoot !== undefined && path.startsWith(CANONICAL_SOUND_CLASS_DIR)
			? join(canonicalRoot, path.slice(CANONICAL_SOUND_CLASS_DIR.length))
			: path;
	return {
		readDir: async (path) => {
			const target = remap(path);
			if (canonicalRoot === undefined && path === CANONICAL_SOUND_CLASS_DIR) {
				const err = new Error("ENOENT") as Error & { code: string };
				err.code = "ENOENT";
				throw err;
			}
			const { readdir } = await import("node:fs/promises");
			return readdir(target);
		},
		readText: async (path) => {
			const target = remap(path);
			return Bun.file(target)
				.text()
				.catch(() => undefined);
		},
	};
}

beforeEach(() => {
	resetAlsaCardScanResolution();
	setMockAudioDevicesProvider(undefined);
});

afterEach(() => {
	resetAlsaCardScanResolution();
	setMockAudioDevicesProvider(undefined);
});

afterAll(async () => {
	// The scan writes a MODULE-LEVEL map that `bun test` shares with every other
	// file in the run; an explicitly-named absent directory restores it to the
	// pseudo-sources-only initial state (the sibling suites' own reset).
	await updateAudioDevices("/nonexistent-audio-root");
	for (const root of roots) await rm(root, { recursive: true, force: true });
	roots.length = 0;
});

/*
 * Board-confirmed on a Rock 5B+ running current CeraUI against
 * `ceralive-device 2026.7.2-20260719T181141`, whose packaged setup.json still
 * carries the pre-#166 `"sound_device_dir": "/dev/snd"`. That directory holds
 * ALSA's device NODES and no `cardN` directory at all, so the sysfs-shaped scan
 * returned zero cards and `audio_sources` collapsed to its two pipeline
 * pseudo-sources — a connected, capture-ready RØDE HDMI-to-USB-C absent from the
 * picker with nothing to say why.
 */
describe("a configured sound directory that names no ALSA card never answers for the hardware", () => {
	test("the board repro: /dev/snd yields nothing, so the kernel's own directory answers", async () => {
		const canonical = await makeCardTree(BOARD_CARDS);
		const { deps } = driftDeps(canonical);

		const cards = await resolveConfiguredAlsaCards("/dev/snd", deps);

		expect(cards.map((c) => c.id)).toEqual([
			"usbaudio",
			"rk3588es8316",
			"hdmi0",
			"hdmi1",
		]);
		expect(getResolvedAlsaCardDir()).toBe(CANONICAL_SOUND_CLASS_DIR);
	});

	test("a configured directory that DOES name cards answers unreconciled", async () => {
		const configured = await makeCardTree([BOARD_CARDS[0] as CardFixture]);
		const canonical = await makeCardTree(BOARD_CARDS);
		const { deps, reads } = driftDeps(canonical);

		const cards = await resolveConfiguredAlsaCards(configured, deps);

		expect(cards.map((c) => c.id)).toEqual(["usbaudio"]);
		expect(getResolvedAlsaCardDir()).toBe(configured);
		expect(reads.some((p) => p.startsWith(CANONICAL_SOUND_CLASS_DIR))).toBe(
			false,
		);
	});

	test("a configured directory that IS the canonical one has nothing to fall back to", async () => {
		const canonical = await makeCardTree([]);
		const { deps, reads } = driftDeps(canonical);

		const cards = await resolveConfiguredAlsaCards(
			CANONICAL_SOUND_CLASS_DIR,
			deps,
		);

		expect(cards).toEqual([]);
		expect(reads.filter((p) => p === CANONICAL_SOUND_CLASS_DIR)).toHaveLength(
			1,
		);
	});

	test("a board that genuinely has no sound card is unchanged — still empty", async () => {
		const canonical = await makeCardTree([]);
		const { deps } = driftDeps(canonical);

		expect(await resolveConfiguredAlsaCards("/dev/snd", deps)).toEqual([]);
		expect(getResolvedAlsaCardDir()).toBe("/dev/snd");
	});

	test("an absent configured directory also defers to the kernel's", async () => {
		const canonical = await makeCardTree(BOARD_CARDS);
		const { deps } = driftDeps(canonical);

		const cards = await resolveConfiguredAlsaCards("/nonexistent-sound", deps);

		expect(cards.map((c) => c.id)).toContain("usbaudio");
	});

	test("the rescue scan can never turn one fault into another", async () => {
		const { deps } = driftDeps(undefined);
		const throwing: AlsaCardScanDeps = {
			readText: deps.readText,
			readDir: async (path) => {
				if (path === CANONICAL_SOUND_CLASS_DIR) {
					const err = new Error("ENOTDIR") as Error & { code: string };
					err.code = "ENOTDIR";
					throw err;
				}
				return deps.readDir(path);
			},
		};

		expect(await resolveConfiguredAlsaCards("/dev/snd", throwing)).toEqual([]);
	});

	test("a non-ENOENT error on the CONFIGURED directory still rejects", async () => {
		const deps: AlsaCardScanDeps = {
			readDir: async () => {
				const err = new Error("ENOTDIR") as Error & { code: string };
				err.code = "ENOTDIR";
				throw err;
			},
			readText: async () => undefined,
		};

		await expect(
			resolveConfiguredAlsaCards("/etc/hostname", deps),
		).rejects.toThrow("ENOTDIR");
	});

	test("a cardN entry with no readable id is not a card", async () => {
		const root = await mkdtemp(join(tmpdir(), "ceraui-alsa-noid-"));
		roots.push(root);
		await mkdir(join(root, "card0"));

		expect(await scanAlsaCards(root)).toEqual([]);
	});
});

/*
 * The `exclude` list in `updateAudioDevices` has always meant "this card is an
 * output". It is a card-id vocabulary, and the kernel's is a different one: the
 * board above names its two HDMI playback cards `hdmi0`/`hdmi1`, which the list
 * (`rockchiphdmi0`/`rockchiphdmi1`) does not match — so the moment the scan
 * starts finding cards again, two speakers would render as selectable
 * microphones. The direction is structural, so it is read structurally.
 */
describe("isPlaybackOnlyCard — a card the kernel proves is an output", () => {
	test("playback substreams and no capture substream is an output", () => {
		expect(isPlaybackOnlyCard(["controlC2", "id", "pcmC2D0p"])).toBe(true);
	});

	test("any capture substream means it is not", () => {
		expect(isPlaybackOnlyCard(["pcmC1D0c", "pcmC1D0p"])).toBe(false);
		expect(isPlaybackOnlyCard(["controlC0", "id", "pcmC0D0c"])).toBe(false);
	});

	test("a card that claims NO direction is not an output — it is the HDMI-RX", () => {
		expect(isPlaybackOnlyCard(["controlC3", "id", "number"])).toBe(false);
		expect(isPlaybackOnlyCard([])).toBe(false);
	});
});

describe("the board's own card tree, through the real scan", () => {
	test("the RØDE and the analog codec are offered; the HDMI outputs are not", async () => {
		const root = await makeCardTree(BOARD_CARDS);

		await updateAudioDevices(root);

		const devices = getAudioDevices();
		expect(Object.values(devices)).toContain("usbaudio");
		expect(Object.values(devices)).toContain("rk3588es8316");
		expect(Object.values(devices)).not.toContain("hdmi0");
		expect(Object.values(devices)).not.toContain("hdmi1");

		expect([...getAudioCaptureCardIds()].sort()).toEqual([
			"rk3588es8316",
			"usbaudio",
		]);

		const wire = deriveAudioSources();
		expect(wire.filter((s) => s.kind === "device").length).toBe(2);
		expect(wire.some((s) => s.label === "RØDE HDMI to USB-C")).toBe(false);
	});

	test("a signal-less capture card still keeps its picker row", async () => {
		const root = await makeCardTree([
			{ dir: "card3", id: "rockchiphdmiin", entries: ["controlC3", "id"] },
			BOARD_CARDS[0] as CardFixture,
		]);

		await updateAudioDevices(root);

		expect(Object.values(getAudioDevices())).toContain("rockchiphdmiin");
		expect([...getAudioCaptureCardIds()]).toEqual(["usbaudio"]);
	});
});

/*
 * Every other card-order assertion in this file reads a REAL temp directory, so
 * it asserts whatever `readdir` happens to answer on the host — creation order
 * on this dev box, filename-hash order on an ext4 CI runner, which is how the
 * board-repro case above passed locally and failed in CI as
 * `hdmi0, hdmi1, rk3588es8316, usbaudio` (card2, card3, card1, card0). These
 * drive the listing directly, so the invariant is pinned on every machine.
 */
describe("card order is the ALSA card index, never the directory listing's", () => {
	const listedAs = (entries: readonly string[]): AlsaCardScanDeps => ({
		readDir: async (path) =>
			path === "/sys/fake" ? [...entries] : ["id", "controlC0"],
		readText: async (path) => {
			const card = path.match(/\/(card\d+)\/id$/)?.[1];
			return card === undefined ? undefined : `${card}-id\n`;
		},
	});

	test("the CI listing order resolves to card-index order", async () => {
		const cards = await scanAlsaCards(
			"/sys/fake",
			listedAs(["card2", "card3", "card1", "card0"]),
		);

		expect(cards.map((c) => c.id)).toEqual([
			"card0-id",
			"card1-id",
			"card2-id",
			"card3-id",
		]);
	});

	test("two-digit cards sort numerically, not lexicographically", async () => {
		const cards = await scanAlsaCards(
			"/sys/fake",
			listedAs(["card10", "card2", "card1"]),
		);

		expect(cards.map((c) => c.id)).toEqual([
			"card1-id",
			"card2-id",
			"card10-id",
		]);
	});

	test("a non-card entry is still not a card", async () => {
		const cards = await scanAlsaCards(
			"/sys/fake",
			listedAs(["timer", "card1", "controlC0", "card0", "pcmC0D0c"]),
		);

		expect(cards.map((c) => c.id)).toEqual(["card0-id", "card1-id"]);
	});
});

/*
 * The rule above is dead unless the PRODUCTION path routes through it, and the
 * production path is the one nothing hands a directory to. A test that always
 * passes its own fixture directory would never touch the resolver at all.
 */
describe("the reconciliation is wired to the configured path, and only to it", () => {
	test("an omitted directory resolves; an explicit one is honoured verbatim", async () => {
		const root = await makeCardTree(BOARD_CARDS);

		await updateAudioDevices(root);
		expect(getResolvedAlsaCardDir()).toBeUndefined();

		await updateAudioDevices();
		expect(getResolvedAlsaCardDir()).toBeDefined();

		await updateAudioDevices("/nonexistent-audio-root");
		expect(getAudioDevices()).toEqual({
			"No audio": "No audio",
			"Pipeline default": "Pipeline default",
		});
	});
});
