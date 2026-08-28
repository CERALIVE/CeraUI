/*
 * The 4-tier audio-naming ladder and the idle-meter preference, driven against
 * PIPEWIRE-ARM engine device reports.
 *
 * WHY THIS FILE EXISTS. cerastream's `[audio] backend = "pipewire"` arm changed
 * WHERE an audio row's identity comes from — PipeWire node props resolved back
 * through `sources/pw_identity.rs` — but deliberately NOT what it is CALLED. The
 * engine still projects the persisted `hw:CARD=<id>` vocabulary and still
 * publishes `alsa_card_id`, so CeraUI's ladder should need no change at all.
 *
 * "Should" is the whole point: this suite PROVES the zero delta rather than
 * asserting it, by rendering ONE physical roster as BOTH arms' `list-devices`
 * payloads, driving both through the REAL `probeEngineDevices` whitelist copy and
 * the REAL ladder, and comparing the results. The arm-only fields are covered in
 * both directions — the ones that must not travel (`device_path`) and the one
 * that does (`device_address`, which must move nothing).
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ListDevicesResult } from "@ceralive/cerastream";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";

import { logger } from "../helpers/logger.ts";
import {
	getAudioDevices,
	resetRememberedAudioIdentities,
	resolveEffectiveAudioPick,
	resolveMeterPreference,
	setMockAudioDevicesProvider,
	updateAudioDevices,
} from "../modules/streaming/audio.ts";
import {
	type EngineAudioDevice,
	resetAudioNamingDiagnostics,
	resolveAudioDisplays,
	resolveAudioIdentities,
	resolveAudioLabels,
} from "../modules/streaming/audio-naming.ts";
import { resolveAutoAsrc } from "../modules/streaming/auto-audio.ts";
import {
	getEngineAudioDevices,
	refreshEngineDeviceCache,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";

// ─── One physical roster, two engine arms ────────────────────────────────────

type Arm = "alsa" | "pipewire";

/**
 * A card as the OPERATOR's board holds it, plus the two arm-dependent strings.
 *
 * `alsaPath` / `pipewirePath` are the `device_path` each provider yields. On the
 * ALSA arm `to_discovered` takes `device_path(props)`; on the PipeWire arm it
 * takes `PipeWireNodeIdentity::persisted_device()`, i.e. the `hw:CARD=` form.
 * They differ on every real board — which is exactly why the whitelist copy NOT
 * carrying `device_path` into `EngineAudioDevice` is worth asserting.
 */
interface RosterCard {
	cardId: string;
	displayName: string;
	alsaPath: string;
	pipewirePath: string;
	productName?: string;
	transport?: EngineAudioDevice["transport"];
	stableId?: string;
	physicalGroupId?: string;
}

const ROSTER: readonly RosterCard[] = [
	// Tier 0 — the RK3588 HDMI-RX audio half. Its only hardware string is a raw
	// driver id on BOTH arms, so the static onboard rule is what names it.
	{
		cardId: "rockchiphdmiin",
		displayName: "rockchip,hdmiin",
		alsaPath: "hw:3,0",
		pipewirePath: "hw:CARD=rockchiphdmiin",
		transport: "hdmi",
		stableId: "card:rockchiphdmiin",
	},
	// Tier 1 via display_name — the board RØDE, whose engine product_name is the
	// generic card id and is rejected by the human-name heuristic.
	{
		cardId: "usbaudio",
		displayName:
			"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed",
		alsaPath: "hw:5,0",
		pipewirePath: "hw:CARD=usbaudio",
		productName: "usbaudio",
		transport: "usb",
		stableId: "card:usbaudio",
		physicalGroupId: "usb:5-1",
	},
	// Tier 1 via product_name — a device whose engine identity IS human.
	{
		cardId: "DJIPocket3",
		displayName: "DJI DJIPocket3 at usb-fc880000.usb-1, high speed",
		alsaPath: "hw:6,0",
		pipewirePath: "hw:CARD=DJIPocket3",
		productName: "DJI Osmo Pocket 3",
		transport: "usb",
		stableId: "card:DJIPocket3",
		physicalGroupId: "usb:1-1.4",
	},
];

/** Render the roster as the engine's `list-devices` result on ONE arm. */
function listDevicesFor(arm: Arm): ListDevicesResult {
	return {
		devices: [
			// A video row rides along so the audio filter is exercised for real.
			{
				input_id: "/dev/video0",
				device_path: "/dev/video0",
				display_name: "rk_hdmirx",
				media_class: "video",
				kind: "hdmi",
			},
			...ROSTER.map((card) => ({
				// `to_discovered` builds an audio id as `hw:CARD=<card>` FIRST on
				// both arms, so the id itself is arm-independent.
				input_id: `hw:CARD=${card.cardId}`,
				device_path: arm === "pipewire" ? card.pipewirePath : card.alsaPath,
				display_name: card.displayName,
				media_class: "audio",
				kind: "audio",
				alsa_card_id: card.cardId,
				...(card.productName !== undefined
					? { product_name: card.productName }
					: {}),
				...(card.transport !== undefined ? { transport: card.transport } : {}),
				...(card.stableId !== undefined ? { stable_id: card.stableId } : {}),
				...(card.physicalGroupId !== undefined
					? { physical_group_id: card.physicalGroupId }
					: {}),
			})),
		],
	} as unknown as ListDevicesResult;
}

/** The picker map the sysfs scan produces for the roster (no aliases applied). */
const ROSTER_CARDS: Record<string, string> = Object.fromEntries(
	ROSTER.map((card) => [card.cardId, card.cardId]),
);

/** `/proc/asound/cards` is a KERNEL file — identical whichever backend runs. */
const ROSTER_LONGNAMES = new Map<string, string>([
	["rockchiphdmiin", "rockchip,hdmirx-controller"],
	[
		"usbaudio",
		"RØDE RØDE HDMI to USB-C at usb-xhci-hcd.17.auto-1, super speed",
	],
	["DJIPocket3", "DJI DJIPocket3 at usb-fc880000.usb-1, high speed"],
]);

/** Commit one arm's payload through the REAL crossing seam and read it back. */
async function engineAudioFor(arm: Arm): Promise<EngineAudioDevice[]> {
	resetEngineDeviceCache();
	const live = listDevicesFor(arm);
	await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });
	return getEngineAudioDevices();
}

/**
 * Return `audio.ts`'s module-level maps to their pristine state.
 *
 * `bun test` runs every file in ONE process and `updateAudioDevices` writes
 * `lastAudioDisplays`/`lastAudioIdentities`, which `deriveAudioSources` reads by
 * DEFAULT. A scan performed while an engine audio cache is committed therefore
 * leaks resolved identities into whichever file runs next — reproduced here as
 * two `audio-naming.test.ts` failures whose fixtures name no transport at all.
 * The cache must be dropped BEFORE the re-scan, or the empty scan re-resolves
 * against the very rows it is meant to forget.
 */
async function clearResolvedAudioState(): Promise<void> {
	resetEngineDeviceCache();
	resetRememberedAudioIdentities();
	const empty = await mkdtemp(join(tmpdir(), "ceraui-audio-reset-"));
	try {
		await updateAudioDevices(empty);
	} finally {
		await rm(empty, { recursive: true, force: true });
	}
}

describe("pipewire-arm engine reports — the audio whitelist crossing", () => {
	afterEach(() => {
		resetEngineDeviceCache();
	});

	test("both arms cross into BYTE-IDENTICAL EngineAudioDevice rows", async () => {
		const alsa = await engineAudioFor("alsa");
		const pipewire = await engineAudioFor("pipewire");

		expect(pipewire).toEqual(alsa);
		expect(pipewire.map((d) => d.alsa_card_id)).toEqual([
			"rockchiphdmiin",
			"usbaudio",
			"DJIPocket3",
		]);
	});

	test("`device_path` is NOT a naming input — it never crosses the whitelist", async () => {
		// The two arms disagree about `device_path` on every row of the roster,
		// which is what makes the equality above a real comparison rather than a
		// tautology. Prove the disagreement exists in the payloads first.
		const alsaPaths = (
			listDevicesFor("alsa").devices as Array<{
				media_class: string;
				device_path?: string;
			}>
		)
			.filter((d) => d.media_class === "audio")
			.map((d) => d.device_path);
		const pipewirePaths = (
			listDevicesFor("pipewire").devices as Array<{
				media_class: string;
				device_path?: string;
			}>
		)
			.filter((d) => d.media_class === "audio")
			.map((d) => d.device_path);
		expect(pipewirePaths).not.toEqual(alsaPaths);

		// …and then that NO row carries it past the crossing, on either arm.
		for (const arm of ["alsa", "pipewire"] as const) {
			for (const row of await engineAudioFor(arm)) {
				expect("device_path" in row).toBe(false);
			}
		}
	});

	test("the 4-tier ladder resolves both arms to the SAME displays and identities", async () => {
		const alsaDisplays = resolveAudioDisplays(
			ROSTER_CARDS,
			await engineAudioFor("alsa"),
			ROSTER_LONGNAMES,
		);
		const pipewireDisplays = resolveAudioDisplays(
			ROSTER_CARDS,
			await engineAudioFor("pipewire"),
			ROSTER_LONGNAMES,
		);
		expect([...pipewireDisplays.entries()]).toEqual([
			...alsaDisplays.entries(),
		]);

		// Named, so a silent collapse to "everything hit tier 3" cannot pass.
		expect(pipewireDisplays.get("rockchiphdmiin")?.label).toBe("HDMI Input");
		expect(pipewireDisplays.get("usbaudio")?.label).toBe("RØDE HDMI to USB-C");
		expect(pipewireDisplays.get("DJIPocket3")?.label).toBe("DJI Osmo Pocket 3");

		const alsaIdentities = resolveAudioIdentities(
			ROSTER_CARDS,
			await engineAudioFor("alsa"),
		);
		const pipewireIdentities = resolveAudioIdentities(
			ROSTER_CARDS,
			await engineAudioFor("pipewire"),
		);
		expect([...pipewireIdentities.entries()]).toEqual([
			...alsaIdentities.entries(),
		]);
	});
});

// ─── The ladder itself, tier by tier, on pipewire-arm rows ───────────────────

describe("pipewire-arm engine reports — the 4-tier ladder, tier by tier", () => {
	test("tier 0: BOTH HDMI-RX kernel spellings take the static onboard rule", async () => {
		// Which spelling a board reports is decided by the KERNEL TRACK, not by
		// the audio backend, so the pipewire arm inherits both cases unchanged.
		// Resolved one board at a time: a single device never reports both, and
		// putting them in one roster would only exercise the " (2)" dedupe.
		for (const [cardId, rawName] of [
			["rockchiphdmiin", "rockchip,hdmiin"],
			["hdmirx", "hdmirx"],
		] as const) {
			const live = {
				devices: [
					{
						input_id: `hw:CARD=${cardId}`,
						device_path: `hw:CARD=${cardId}`,
						display_name: rawName,
						media_class: "audio",
						kind: "audio",
						alsa_card_id: cardId,
					},
				],
			} as unknown as ListDevicesResult;
			resetEngineDeviceCache();
			await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });

			const displays = resolveAudioDisplays(
				{ [cardId]: cardId },
				getEngineAudioDevices(),
				new Map(),
			);
			expect(displays.get(cardId)?.label).toBe("HDMI Input");
			// The raw driver id is MOVED to `detail`, never deleted.
			expect(displays.get(cardId)?.detail).toBe(rawName);
		}
		resetEngineDeviceCache();
	});

	test("tier 1: a human product_name wins, and a generic one falls through", async () => {
		const engine = await engineAudioFor("pipewire");
		const labels = resolveAudioLabels(ROSTER_CARDS, engine, ROSTER_LONGNAMES);
		// DJI: product_name is human → tier 1 takes it.
		expect(labels.get("DJIPocket3")).toBe("DJI Osmo Pocket 3");
		// RØDE: product_name === the card id → rejected, display_name used.
		expect(labels.get("usbaudio")).toBe("RØDE HDMI to USB-C");
		resetEngineDeviceCache();
	});

	test("tier 2: a pipewire row whose join key is absent falls to the KERNEL longname", async () => {
		// `/proc/asound/cards` is read by CeraUI itself and is backend-independent,
		// so it is the tier that CANNOT drift between arms.
		const live = {
			devices: [
				{
					input_id: "hw:CARD=usbaudio",
					device_path: "hw:CARD=usbaudio",
					display_name: "RØDE analog stereo",
					media_class: "audio",
					kind: "audio",
					// Join key deliberately absent — a node the provider could not
					// relate to an ALSA card.
				},
			],
		} as unknown as ListDevicesResult;
		resetEngineDeviceCache();
		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });

		const labels = resolveAudioLabels(
			{ usbaudio: "usbaudio" },
			getEngineAudioDevices(),
			new Map([["usbaudio", "Generic USB Audio Device"]]),
		);
		expect(labels.get("usbaudio")).toBe("Generic USB Audio Device");
		resetEngineDeviceCache();
	});

	test("a pipewire-only `device_address` moves NOTHING in the ladder", async () => {
		// The engine's own contract for this field is that carrying it changes no
		// other value on the record (cerastream:
		// `a_node_that_advertises_a_device_address_carries_it_verbatim`). This is
		// CeraUI's half of that: it reaches `EngineAudioDevice` and is inert here.
		const base = {
			input_id: "hw:CARD=usbaudio",
			device_path: "hw:CARD=usbaudio",
			display_name: "RØDE AI-Micro",
			media_class: "audio",
			kind: "audio",
			alsa_card_id: "usbaudio",
			product_name: "RØDE AI-Micro",
			transport: "usb",
			stable_id: "card:usbaudio",
		};

		resetEngineDeviceCache();
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () =>
				({ devices: [base] }) as unknown as ListDevicesResult,
		});
		const without = getEngineAudioDevices();
		const withoutDisplays = resolveAudioDisplays(
			{ usbaudio: "usbaudio" },
			without,
			new Map(),
		);
		const withoutIdentities = resolveAudioIdentities(
			{ usbaudio: "usbaudio" },
			without,
		);

		resetEngineDeviceCache();
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () =>
				({
					devices: [{ ...base, device_address: "AA:BB:CC:DD:EE:FF" }],
				}) as unknown as ListDevicesResult,
		});
		const withAddress = getEngineAudioDevices();

		// The field DID cross (otherwise the comparison below is vacuous)…
		expect(withAddress[0]?.device_address).toBe("AA:BB:CC:DD:EE:FF");
		// …and it changed no other field on the row…
		expect({ ...withAddress[0], device_address: undefined }).toEqual({
			...without[0],
			device_address: undefined,
		});
		// …and no label, detail or identity moved with it.
		expect([
			...resolveAudioDisplays(
				{ usbaudio: "usbaudio" },
				withAddress,
				new Map(),
			).entries(),
		]).toEqual([...withoutDisplays.entries()]);
		expect([
			...resolveAudioIdentities(
				{ usbaudio: "usbaudio" },
				withAddress,
			).entries(),
		]).toEqual([...withoutIdentities.entries()]);
		resetEngineDeviceCache();
	});
});

// ─── Tier 3 + its diagnostic, on a pipewire-arm row ──────────────────────────

describe("pipewire-arm engine reports — tier 3 alias fallback keeps its diagnostic", () => {
	let infoSpy: ReturnType<typeof spyOn<typeof logger, "info">>;

	beforeEach(() => {
		resetAudioNamingDiagnostics();
		infoSpy = spyOn(logger, "info").mockImplementation((() => logger) as never);
	});
	afterEach(() => {
		infoSpy.mockRestore();
		resetAudioNamingDiagnostics();
		resetEngineDeviceCache();
	});

	function diagnosticRecords(): Array<[string, Record<string, unknown>]> {
		const calls = infoSpy.mock.calls as unknown as unknown[][];
		return calls.filter(
			(call) =>
				(call[1] as { module?: string } | undefined)?.module === "audio-naming",
		) as Array<[string, Record<string, unknown>]>;
	}

	test("a pipewire row with NO join key falls to tier 3 AND logs the miss", async () => {
		// The pipewire arm's own way of losing the key: a node whose provider
		// published no `api.alsa.card.id`, so `alsa_card_id` is absent on the wire.
		const live = {
			devices: [
				{
					input_id: "alsa_input.usb-RODE-00.analog-stereo",
					device_path: "alsa_input.usb-RODE-00.analog-stereo",
					display_name: "RØDE AI-Micro Analog Stereo",
					media_class: "audio",
					kind: "audio",
				},
			],
		} as unknown as ListDevicesResult;
		resetEngineDeviceCache();
		await refreshEngineDeviceCache({ fetchEngineDevices: async () => live });

		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			getEngineAudioDevices(),
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("USB audio");

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			module: "audio-naming",
			cardId: "usbaudio",
			engineEntryPresent: false,
			longnamePresent: false,
			// The pipewire-arm row IS present in the list, just unjoinable — which
			// is exactly the cause this field exists to name.
			engineEntriesWithoutJoinKey: 1,
		});
	});

	test("the SAME miss on the alsa arm produces the SAME label and the SAME record", async () => {
		const alsaLive = {
			devices: [
				{
					input_id: "hw:5,0",
					device_path: "hw:5,0",
					display_name: "RØDE AI-Micro",
					media_class: "audio",
					kind: "audio",
				},
			],
		} as unknown as ListDevicesResult;
		resetEngineDeviceCache();
		await refreshEngineDeviceCache({
			fetchEngineDevices: async () => alsaLive,
		});

		const labels = resolveAudioLabels(
			{ "USB audio": "usbaudio" },
			getEngineAudioDevices(),
			new Map(),
		);
		expect(labels.get("USB audio")).toBe("USB audio");

		const records = diagnosticRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.[1]).toMatchObject({
			cardId: "usbaudio",
			engineEntryPresent: false,
			engineEntriesWithoutJoinKey: 1,
		});
	});
});

// ─── The idle-meter preference on the pipewire arm ───────────────────────────

const ENV_KEYS = ["MOCK_MODE", "MOCK_SCENARIO", "NODE_ENV"] as const;

describe("resolveMeterPreference / resolveEffectiveAudioPick — pipewire arm", () => {
	const savedEnv: Record<string, string | undefined> = {};
	let scanRoot: string | undefined;

	beforeEach(async () => {
		for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
		process.env.NODE_ENV = "development";
		// A real sysfs-shaped scan, so the picker map is produced by the shipped
		// reader rather than injected. The scan is CeraUI's own `/sys/class/sound`
		// walk and is entirely independent of the engine's audio backend — which
		// is itself half of why the preference cannot drift between arms.
		scanRoot = await mkdtemp(join(tmpdir(), "ceraui-pw-arm-"));
		for (const card of [
			{ dir: "card3", id: "rockchiphdmiin", entries: [] as string[] },
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
			{ dir: "card6", id: "DJIPocket3", entries: ["pcmC6D0c"] },
			{ dir: "card7", id: "MINI", entries: ["pcmC7D0c"] },
		]) {
			await mkdir(join(scanRoot, card.dir));
			await Bun.write(join(scanRoot, card.dir, "id"), `${card.id}\n`);
			for (const entry of card.entries) {
				await mkdir(join(scanRoot, card.dir, entry));
			}
		}
		await updateAudioDevices(scanRoot);
	});

	afterEach(async () => {
		await clearResolvedAudioState();
		setMockAudioDevicesProvider(undefined);
		if (scanRoot !== undefined) {
			await rm(scanRoot, { recursive: true, force: true });
			scanRoot = undefined;
		}
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	/** The picker key a card is listed under (alias-resolved, kind-dependent). */
	function pickerKeyFor(cardId: string): string {
		const entry = Object.entries(getAudioDevices()).find(
			([, id]) => id === cardId,
		);
		if (entry === undefined) throw new Error(`card ${cardId} is not listed`);
		return entry[0];
	}

	test("an explicit pick resolves identically with EITHER arm's list committed", async () => {
		const picks = [
			pickerKeyFor("usbaudio"),
			pickerKeyFor("DJIPocket3"),
			pickerKeyFor("MINI"),
		];

		await engineAudioFor("alsa");
		const onAlsa = picks.map((pick) => resolveMeterPreference(pick));

		await engineAudioFor("pipewire");
		const onPipewire = picks.map((pick) => resolveMeterPreference(pick));

		expect(onPipewire).toEqual(onAlsa);
		expect(onPipewire).toEqual([
			"hw:CARD=usbaudio",
			"hw:CARD=DJIPocket3",
			"hw:CARD=MINI",
		]);
	});

	test("the pseudo-sources and an unset pick still hand back to the engine", async () => {
		await engineAudioFor("pipewire");
		for (const asrc of ["No audio", "Pipeline default", undefined]) {
			expect(resolveMeterPreference(asrc)).toBeNull();
		}
	});

	test("`Auto` rule 5 joins on `physical_group_id` identically on both arms", async () => {
		// Rule 5 is the ONE resolution that reads the engine's audio list, so it
		// is where an arm difference could actually surface. Driven through the
		// pure resolver with each arm's real crossed rows.
		const camera = {
			id: "/dev/video1",
			origin: "capture" as const,
			kind: "uvc_h264" as const,
			physicalGroupId: "usb:1-1.4",
		};

		async function autoFor(arm: Arm) {
			const engineAudio = await engineAudioFor(arm);
			return resolveAutoAsrc({
				source: camera as never,
				audioDevices: getAudioDevices(),
				engineAudio,
				captureCapableCardIds: new Set(["DJIPocket3", "usbaudio", "MINI"]),
			});
		}

		const onAlsa = await autoFor("alsa");
		const onPipewire = await autoFor("pipewire");

		expect(onPipewire).toEqual(onAlsa);
		expect(onPipewire.reason).toBe("usb-same-device");
		expect(onPipewire.cardId).toBe("DJIPocket3");

		// …and the meter follows that resolution, not the sentinel.
		const pick = resolveEffectiveAudioPick(AUDIO_SOURCE_AUTO, () => onPipewire);
		expect(pick).toBe(onPipewire.asrcKey ?? undefined);
		expect(resolveMeterPreference(AUDIO_SOURCE_AUTO, () => onPipewire)).toBe(
			"hw:CARD=DJIPocket3",
		);
	});
});

// ─── Persisted-config compatibility: NO MIGRATION REQUIRED ───────────────────

/**
 * The acceptance this todo exists for.
 *
 * Every value below is one a device could ALREADY have in `config.asrc` before
 * any PipeWire work existed: the alias display name, a bare card id, and the raw
 * `hw:CARD=` selector `resolveMeterPreference` has always passed through. Each
 * must resolve to the same engine target with a pipewire-arm device list
 * committed as it does with an alsa-arm one — and to the value the pre-migration
 * build produced, which is written out literally rather than derived.
 */
describe("pre-migration `config.asrc` values resolve unchanged on the pipewire arm", () => {
	const savedEnv: Record<string, string | undefined> = {};
	let scanRoot: string | undefined;

	beforeEach(async () => {
		for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
		process.env.NODE_ENV = "development";
		scanRoot = await mkdtemp(join(tmpdir(), "ceraui-premigration-"));
		for (const card of [
			{ dir: "card5", id: "usbaudio", entries: ["pcmC5D0c"] },
			{ dir: "card7", id: "MINI", entries: ["pcmC7D0c"] },
		]) {
			await mkdir(join(scanRoot, card.dir));
			await Bun.write(join(scanRoot, card.dir, "id"), `${card.id}\n`);
			for (const entry of card.entries) {
				await mkdir(join(scanRoot, card.dir, entry));
			}
		}
		await updateAudioDevices(scanRoot);
	});

	afterEach(async () => {
		await clearResolvedAudioState();
		setMockAudioDevicesProvider(undefined);
		if (scanRoot !== undefined) {
			await rm(scanRoot, { recursive: true, force: true });
			scanRoot = undefined;
		}
		for (const k of ENV_KEYS) {
			const v = savedEnv[k];
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	});

	function pickerKeyFor(cardId: string): string {
		const entry = Object.entries(getAudioDevices()).find(
			([, id]) => id === cardId,
		);
		if (entry === undefined) throw new Error(`card ${cardId} is not listed`);
		return entry[0];
	}

	test("a persisted `hw:CARD=…` selector is passed through byte-for-byte", async () => {
		await engineAudioFor("pipewire");
		expect(resolveMeterPreference("hw:CARD=usbaudio")).toBe("hw:CARD=usbaudio");
		expect(resolveMeterPreference("plughw:CARD=usbaudio,DEV=0")).toBe(
			"plughw:CARD=usbaudio,DEV=0",
		);
		expect(resolveMeterPreference("hw:1,0")).toBe("hw:1,0");
	});

	test("a persisted BARE card id still wraps to its `hw:CARD=` form", async () => {
		await engineAudioFor("pipewire");
		// `MINI` carries no display alias, so the persisted value IS the card id —
		// the shape a pre-alias config holds.
		expect(resolveMeterPreference("MINI")).toBe("hw:CARD=MINI");
		expect(resolveMeterPreference(pickerKeyFor("usbaudio"))).toBe(
			"hw:CARD=usbaudio",
		);
	});

	test("every pre-migration shape resolves IDENTICALLY on both arms", async () => {
		const persisted = [
			"hw:CARD=usbaudio",
			"plughw:CARD=usbaudio,DEV=0",
			"hw:1,0",
			"MINI",
			pickerKeyFor("usbaudio"),
			"No audio",
			"Pipeline default",
			undefined,
		];

		await engineAudioFor("alsa");
		const onAlsa = persisted.map((asrc) => resolveMeterPreference(asrc));

		await engineAudioFor("pipewire");
		const onPipewire = persisted.map((asrc) => resolveMeterPreference(asrc));

		expect(onPipewire).toEqual(onAlsa);
		// The literal pre-migration answers, so a change on BOTH arms at once is
		// still a failure rather than a silently-agreeing regression.
		expect(onPipewire).toEqual([
			"hw:CARD=usbaudio",
			"plughw:CARD=usbaudio,DEV=0",
			"hw:1,0",
			"hw:CARD=MINI",
			"hw:CARD=usbaudio",
			null,
			null,
			null,
		]);
	});

	test("a persisted pick's LABEL is unchanged by the arm the engine runs", async () => {
		const cards = { ...ROSTER_CARDS };
		const onAlsa = resolveAudioLabels(
			cards,
			await engineAudioFor("alsa"),
			ROSTER_LONGNAMES,
		);
		const onPipewire = resolveAudioLabels(
			cards,
			await engineAudioFor("pipewire"),
			ROSTER_LONGNAMES,
		);
		expect([...onPipewire.entries()]).toEqual([...onAlsa.entries()]);
	});
});
