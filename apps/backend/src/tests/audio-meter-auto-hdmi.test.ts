import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
	CerastreamClient,
	EventHandler,
	EventParams,
	GetCapabilitiesResult,
	Subscription,
} from "@ceralive/cerastream";
import { SCHEMA_VERSION } from "@ceralive/cerastream";
import type { AudioLevelMessage, CaptureDevice } from "@ceraui/rpc/schemas";
import { AUDIO_SOURCE_AUTO } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { getConfig } from "../modules/config.ts";
import {
	getAudioDevices,
	isMeterPreferenceDevicePresent,
	reresolveAudioForEngineChange,
	resolveMeterPreference,
	updateAudioDevices,
} from "../modules/streaming/audio.ts";
import {
	type AudioMeterBridgeDeps,
	type AudioMeterBridgeLogger,
	initAudioMeterBridge,
	isForeignCardLevel,
	settleAudioMeterBridge,
	stopAudioMeterBridge,
} from "../modules/streaming/audio-meter-bridge.ts";
import type { AutoAsrcResolution } from "../modules/streaming/auto-audio.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import {
	initPipelines,
	setMockHardware,
} from "../modules/streaming/pipelines.ts";
import {
	applyObservedEngineDevices,
	resetEngineDeviceCache,
} from "../modules/streaming/sources.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

/*
 * Live board bug: with the HDMI source (`rk_hdmirx`, /dev/video0) selected and
 * "Audio source: Auto", the level meter drew REAL, MOVING bars — for a card that
 * structurally cannot deliver audio at all. `/proc/asound/pcm` carries
 * `03-00: rockchip,hdmiin i2s-hifi-0 : ` with NO `capture N` field and
 * /sys/class/sound/card3 has no `pcmC3D0c` node, so a start with that pick fails
 * `audio-device-unavailable`. The bars belonged to the RØDE USB card.
 *
 * Cause: `resolveMeterPreference` short-circuits `AUDIO_SOURCE_AUTO` to `null`
 * ("engine, choose for yourself"), which ALSO disarms `isForeignCardLevel` (it
 * refuses to call a level foreign unless BOTH sides name a card). That was sound
 * while "Auto" really did hand sourcing to the engine — but `resolveAutoAsrc`
 * (PR #252) made "Auto" a DETERMINISTIC CeraUI-side resolution: HDMI video
 * resolves to the `rockchiphdmiin` card by rule 3. So the meter and the program
 * leg now disagree about which card the pick names, which is exactly the
 * invariant the meter preference was introduced to hold.
 *
 * The "Auto" resolution is INJECTED here rather than assembled out of the live
 * sources graph: `auto-audio.test.ts` already proves `resolveAutoAsrcFromLiveState`
 * applies rule 3 to an HDMI source, and this file is about what the METER does
 * with that answer.
 */

const HDMI_CARD_ID = "rockchiphdmiin";
const USB_CARD_ID = "usbaudio";

const silent: AudioMeterBridgeLogger = {
	info: () => {},
	warn: () => {},
	debug: () => {},
};

/** A sysfs-shaped card tree: HDMI-RX with NO capture PCM, USB audio with one. */
async function scanBoardCards(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "ceraui-meter-auto-"));
	const cards: Array<{ dir: string; id: string; entries: string[] }> = [
		// The board's card 3 — listed forever, zero capture substreams.
		{ dir: "card3", id: HDMI_CARD_ID, entries: [] },
		{ dir: "card5", id: USB_CARD_ID, entries: ["pcmC5D0c"] },
	];
	for (const card of cards) {
		await mkdir(join(root, card.dir));
		await Bun.write(join(root, card.dir, "id"), `${card.id}\n`);
		for (const entry of card.entries) await mkdir(join(root, card.dir, entry));
	}
	await updateAudioDevices(root);
	return root;
}

/*
 * `updateAudioDevices` writes a MODULE-LEVEL map, and `getAudioDevices()` resolves
 * it as `{...mockProvider, ...audioDevices}` — the real scan WINS. `bun test` shares
 * one process, so leaving this file's fixture in place shadows a sibling file's
 * `setMockAudioDevicesProvider` entry for any key they have in common: `usbaudio`
 * carries the BASE alias "USB audio", which is exactly the key
 * `switch-input-follow.test.ts` mocks. Scanning an empty tree restores the map to
 * the module's initial pseudo-sources-only state.
 */
afterAll(async () => {
	const empty = await mkdtemp(join(tmpdir(), "ceraui-meter-reset-"));
	try {
		await updateAudioDevices(empty);
	} finally {
		await rm(empty, { recursive: true, force: true });
	}
});

/** The picker key for a card id — alias-resolved, so never hardcode a label. */
function pickerKeyFor(cardId: string): string {
	const entry = Object.entries(getAudioDevices()).find(
		([, id]) => id === cardId,
	);
	if (entry === undefined) throw new Error(`card ${cardId} is not listed`);
	return entry[0];
}

/** `resolveAutoAsrc` rule 3: an HDMI video source follows the HDMI audio card. */
function hdmiResolution(): AutoAsrcResolution {
	return {
		asrcKey: pickerKeyFor(HDMI_CARD_ID),
		cardId: HDMI_CARD_ID,
		reason: "hdmi",
	};
}

/** `resolveAutoAsrc` rule 5: a USB camera follows its OWN audio card. */
function usbSameDeviceResolution(): AutoAsrcResolution {
	return {
		asrcKey: pickerKeyFor(USB_CARD_ID),
		cardId: USB_CARD_ID,
		reason: "usb-same-device",
	};
}

describe("resolveMeterPreference — 'Auto' names the SAME card the start path would", () => {
	let root: string | undefined;

	beforeEach(async () => {
		root = await scanBoardCards();
	});
	afterEach(async () => {
		if (root !== undefined) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	// THE BUG. "Auto" + HDMI video resolves to the HDMI-RX card on the start path,
	// so the idle meter must prefer that card too — otherwise the engine keeps
	// auto-picking whatever it CAN open and the meter reports a different device.
	test("Auto + an HDMI video source prefers the HDMI-RX card, not `null`", () => {
		expect(resolveMeterPreference(AUDIO_SOURCE_AUTO, hdmiResolution)).toBe(
			`hw:CARD=${HDMI_CARD_ID}`,
		);
	});

	// The consequence that reached the operator: with a real preference the
	// foreign-card gate is ARMED, so the RØDE's real moving level is refused.
	// With `null` it is disarmed and those bars render as HDMI embedded audio.
	test("Auto + HDMI ARMS the foreign-card gate against another card's level", () => {
		const preference = resolveMeterPreference(
			AUDIO_SOURCE_AUTO,
			hdmiResolution,
		);

		expect(isForeignCardLevel(preference, `card:${USB_CARD_ID}`)).toBe(true);
	});

	// A card with no capture PCM can never be metered, so the honest gap is
	// `no_device` — the same answer an unplugged card gets — never a mismatch.
	test("Auto + HDMI reports the card ABSENT (→ no_device, not not_selected_device)", () => {
		expect(
			isMeterPreferenceDevicePresent(AUDIO_SOURCE_AUTO, hdmiResolution),
		).toBe(false);
	});

	// The other side of the same rule: when "Auto" lands on a card that DOES own a
	// capture PCM, the meter follows it and a mismatch is a real mismatch.
	test("Auto + a same-device USB card prefers that card and reports it PRESENT", () => {
		expect(
			resolveMeterPreference(AUDIO_SOURCE_AUTO, usbSameDeviceResolution),
		).toBe(`hw:CARD=${USB_CARD_ID}`);
		expect(
			isMeterPreferenceDevicePresent(
				AUDIO_SOURCE_AUTO,
				usbSameDeviceResolution,
			),
		).toBe(true);
		// ...and the engine metering exactly that card is NOT foreign.
		expect(
			isForeignCardLevel(
				resolveMeterPreference(AUDIO_SOURCE_AUTO, usbSameDeviceResolution),
				`card:${USB_CARD_ID}`,
			),
		).toBe(false);
	});

	// NOT a pin. Every "Auto" outcome that names no single card must still hand
	// selection back to the engine, exactly as before — otherwise a resolution the
	// UI turns into a manual-selection prompt would leave the meter dead.
	test.each([
		["embedded network audio", { asrcKey: null, reason: "embedded" }],
		[
			"pipeline default",
			{ asrcKey: "Pipeline default", reason: "pipeline-default" },
		],
		["no same-device audio", { asrcKey: null, reason: "no-same-device-audio" }],
		[
			"ambiguous same-device audio",
			{ asrcKey: null, reason: "ambiguous-same-device-audio" },
		],
	] as const)("Auto that names no single card stays `null` — engine chooses (%s)", (_label, partial) => {
		const resolution = {
			cardId: null,
			...partial,
		} as AutoAsrcResolution;

		expect(resolveMeterPreference(AUDIO_SOURCE_AUTO, () => resolution)).toBe(
			null,
		);
		expect(
			isMeterPreferenceDevicePresent(AUDIO_SOURCE_AUTO, () => resolution),
		).toBe(false);
	});

	// Regression guard: a MANUAL pick never consults the Auto resolver at all.
	test("a manual pick is byte-unchanged and never calls the Auto resolver", () => {
		let called = 0;
		const resolver = () => {
			called += 1;
			return hdmiResolution();
		};

		expect(resolveMeterPreference(pickerKeyFor(USB_CARD_ID), resolver)).toBe(
			`hw:CARD=${USB_CARD_ID}`,
		);
		expect(resolveMeterPreference("No audio", resolver)).toBe(null);
		expect(resolveMeterPreference("Pipeline default", resolver)).toBe(null);
		expect(resolveMeterPreference(undefined, resolver)).toBe(null);
		expect(called).toBe(0);
	});
});

// ─── The rendered consequence: the bridge must refuse those bars ──────────────

type TimerHandle = ReturnType<typeof setTimeout>;

function bridgeHarness(meterPreference: () => string | null) {
	let handler: EventHandler | undefined;
	const broadcasts: AudioLevelMessage[] = [];
	const reloads: unknown[] = [];

	const subscription: Subscription = {
		result: { topics: ["audio-level"] },
		close: () => {},
	};
	const client: CerastreamClient = {
		subscribeEvents: async (_params, h) => {
			handler = h;
			return subscription;
		},
		close: async () => {},
		hello: { schema_version: "0.9.0" },
		rawRequest: async (_method: string, params?: unknown) => {
			reloads.push(params);
			return {};
		},
		// biome-ignore lint/suspicious/noExplicitAny: the bridge uses only these five members.
	} as any;

	const deps: AudioMeterBridgeDeps = {
		connect: async () => client,
		connectOptions: {},
		broadcast: (payload) => broadcasts.push(payload),
		// Production wiring, with the Auto resolution injected.
		meterPreference,
		meterPreferencePresent: () => false,
		meterSilenced: () => false,
		logger: silent,
		random: () => 0.5,
		now: () => 1_000,
		setTimer: (_fn: () => void, _ms: number): TimerHandle =>
			0 as unknown as TimerHandle,
		clearTimer: () => {},
		baseDelayMs: 1,
		maxDelayMs: 4,
	};

	return {
		deps,
		broadcasts,
		reloads,
		emit: (event: EventParams) => handler?.(event),
	};
}

/** The RØDE's real, moving level — ~49 % fill on both channels. */
const foreignUsbLevel: Extract<EventParams, { type: "audio-level" }> = {
	type: "audio-level",
	seq: 7,
	source: { identity: `card:${USB_CARD_ID}`, owner: "sidecar" },
	channels: 2,
	rms_db: [-30, -30.5],
	peak_db: [-24, -24.5],
	floor_db: -1e6,
};

describe("audio-meter bridge — HDMI+Auto never draws another card's bars", () => {
	let root: string | undefined;

	beforeEach(async () => {
		root = await scanBoardCards();
	});
	afterEach(async () => {
		stopAudioMeterBridge();
		if (root !== undefined) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	test("suppresses the USB card's real level as `no_device` instead of broadcasting it", async () => {
		const h = bridgeHarness(() =>
			resolveMeterPreference(AUDIO_SOURCE_AUTO, hdmiResolution),
		);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.broadcasts.length = 0;

		h.emit(foreignUsbLevel);

		// NOT a level. A card with no capture PCM is genuinely NO audio.
		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "no_device" }]);
	});

	test("the engine is told to prefer the HDMI card, not handed a `null` auto-pick", async () => {
		const h = bridgeHarness(() =>
			resolveMeterPreference(AUDIO_SOURCE_AUTO, hdmiResolution),
		);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();

		expect(h.reloads).toEqual([
			{ audio: { meter_device: `hw:CARD=${HDMI_CARD_ID}` } },
		]);
	});
});

/*
 * The same class, reached without any operator action: "Auto" rule 5 joins the
 * camera to its same-`physical_group_id` audio card out of the ENGINE's audio
 * list, which lands seconds after a udev hotplug and on its own schedule. So a
 * changed engine list can move the resolved card while the sysfs scan — and the
 * pick — are untouched, and the meter preference must follow it.
 */
describe("reresolveAudioForEngineChange — an engine-list change re-points the meter", () => {
	let root: string | undefined;

	beforeEach(async () => {
		root = await scanBoardCards();
		getConfig().asrc = AUDIO_SOURCE_AUTO;
	});
	afterEach(async () => {
		stopAudioMeterBridge();
		delete getConfig().asrc;
		if (root !== undefined) await rm(root, { recursive: true, force: true });
		root = undefined;
	});

	test("re-pushes when the Auto join moves, and stays silent when it does not", async () => {
		let resolution = usbSameDeviceResolution();
		const h = bridgeHarness(() =>
			resolveMeterPreference(AUDIO_SOURCE_AUTO, () => resolution),
		);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;
		h.broadcasts.length = 0;

		// An engine list that resolves to the SAME card must not blink the meter.
		await reresolveAudioForEngineChange();
		expect(h.broadcasts).toEqual([]);

		// One that moves the join must reach the engine — `set_preferred_device`
		// early-returns on an unchanged value, so nothing else would correct it.
		resolution = hdmiResolution();
		await reresolveAudioForEngineChange();

		expect(h.reloads).toContainEqual({
			audio: { meter_device: `hw:CARD=${HDMI_CARD_ID}` },
		});
		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "handoff" }]);
	});
});

// ─── The push: a VIDEO source change moves the Auto-resolved audio pick ───────

function makeContext(): RPCContext {
	const ws = {
		send: () => {},
		data: { isAuthenticated: true, lastActive: Date.now() },
	} as unknown as AppWebSocket;
	return {
		ws,
		isAuthenticated: () => true,
		authenticate: () => {},
		deauthenticate: () => {},
		markActive: () => {},
		getLastActive: () => 0,
		setSenderId: () => {},
		getSenderId: () => undefined,
		clearSenderId: () => {},
	};
}

function capSource(id: string): GetCapabilitiesResult["sources"][number] {
	return {
		id,
		supports_audio: true,
		supports_resolution_override: true,
		supports_framerate_override: true,
		default_resolution: "1080p",
		default_framerate: 30,
	};
}

// `hdmi` must be a capability source or `buildSources` drops the device: a row
// whose bridged pipeline the registry does not carry is not selectable. The other
// three are carried so this file's cached snapshot is not a NARROWER registry than
// its neighbours expect — `bun test` shares one process, so a partial source list
// left in the capability cache reads as a missing pipeline in another file.
const CAPS: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "2160p",
	},
	encoder: {
		codecs: ["h264", "h265"],
		bitrate_range: { min: 500, max: 50000, unit: "kbps" },
	},
	sources: [
		capSource("hdmi"),
		capSource("libuvch264"),
		capSource("usb_mjpeg"),
		capSource("test"),
	],
};

function provide() {
	return {
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	};
}

function videoDevice(inputId: string, kind: string): CaptureDevice {
	return {
		input_id: inputId,
		device_path: `/dev/${inputId}`,
		display_name: inputId,
		media_class: "video",
		kind,
		caps: [
			{
				width: 1920,
				height: 1080,
				framerate: "60000/1001",
				media_type: "video/x-h264",
			},
		],
		// biome-ignore lint/suspicious/noExplicitAny: only the fields buildSources reads.
	} as any;
}

/*
 * `syncAudioMeterPreference()` fired on an `asrc` change only. Under "Auto" the
 * audio pick is a function of the VIDEO source, so switching camera → HDMI (with
 * `asrc` untouched at "Auto") moved the resolved card and told the engine
 * nothing — the meter kept reporting the previous device indefinitely, since
 * `set_preferred_device` early-returns on an unchanged value.
 */
describe("streaming.setConfig — a VIDEO source change re-points the idle meter under Auto", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	let root: string | undefined;
	let priorSource: string | undefined;
	let priorAsrc: string | undefined;
	let priorPipeline: string | undefined;

	beforeAll(async () => {
		process.env.MOCK_MODE = "true";
		process.env.NODE_ENV = "development";
		initMockService("caps-full");
		setMockHardware("rk3588");
		await initPipelines(provide());
	});
	beforeEach(async () => {
		root = await scanBoardCards();
		const config = getConfig();
		priorSource = config.source;
		priorAsrc = config.asrc;
		priorPipeline = config.pipeline;
		resetEngineDeviceCache();
		config.asrc = AUDIO_SOURCE_AUTO;
		config.source = undefined;
		config.pipeline = undefined;
	});
	afterEach(async () => {
		stopAudioMeterBridge();
		const config = getConfig();
		config.source = priorSource;
		config.asrc = priorAsrc;
		config.pipeline = priorPipeline;
		resetEngineDeviceCache();
		updateStatus(false);
		if (root !== undefined) await rm(root, { recursive: true, force: true });
		root = undefined;
	});
	afterAll(async () => {
		stopMockService();
		setMockHardware("rk3588");
		clearCapabilitiesCache();
		await initPipelines();
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("a source-only save re-pushes the newly-resolved meter device", async () => {
		applyObservedEngineDevices([videoDevice("video0", "hdmi")]);

		// The engine's idle meter starts out following the USB card (the operator's
		// previous camera resolved there); the HDMI source is what they pick next.
		let resolution = usbSameDeviceResolution();
		const h = bridgeHarness(() =>
			resolveMeterPreference(AUDIO_SOURCE_AUTO, () => resolution),
		);
		initAudioMeterBridge(h.deps);
		await settleAudioMeterBridge();
		h.reloads.length = 0;
		h.broadcasts.length = 0;

		// Picking the HDMI source moves the Auto resolution to the HDMI card.
		resolution = hdmiResolution();
		const result = await call(
			setConfigProcedure,
			{ source: "video0" },
			{ context: makeContext() },
		);
		expect(result.success).toBe(true);

		// The engine MUST be re-pointed, and the previous card's reading retired.
		expect(h.reloads).toEqual([
			{ audio: { meter_device: `hw:CARD=${HDMI_CARD_ID}` } },
		]);
		expect(h.broadcasts).toEqual([{ unavailable: true, reason: "handoff" }]);
	});
});
