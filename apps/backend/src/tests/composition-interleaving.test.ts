/**
 * Every composition write from two clients with stale views composes.
 *
 * Two simulated clients each hold their own (often stale) copy of the device's
 * composition and send exactly what the card and the designer send from such a
 * view: enable and disable as whole compositions, every other control as a
 * delta (`composition_patch`, `composition_rect`). Steps interleave
 * deterministically (a seeded generator, no timers), idle and live, with live
 * changes sometimes refused by the engine. After every step the device's saved
 * composition, and live what the engine was asked to run, equal a plain
 * reference model that applies each control's intent to the device's own state.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type GetCapabilitiesResult,
	SCHEMA_VERSION,
} from "@ceralive/cerastream";
import {
	COMPOSITION_LAYOUT_DEFAULT,
	COMPOSITION_LAYOUTS,
	type CompositionConfig,
	type CompositionRect,
	presetRect,
	type StreamingSetConfigInput,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import {
	getConfig,
	getConfigFilePath,
	setConfigFilePath,
} from "../modules/config.ts";
import { clearCapabilitiesCache } from "../modules/streaming/capabilities.ts";
import { setApplyNowGateForTest } from "../modules/streaming/config-change-bridge.ts";
import {
	clearStagedConfigChange,
	defaultStagingDeps,
} from "../modules/streaming/config-change-staging.ts";
import { initPipelines } from "../modules/streaming/pipelines.ts";
import { setConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

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
	sources: [],
	features: ["composition", "composition-geometry"],
};
const FIRST_CANDIDATE = "camera-b";
const SECOND_INPUTS = ["camera-b", "camera-c", "camera-d"];

type Composition = CompositionConfig | undefined;
type Op =
	| { kind: "enable" }
	| { kind: "disable" }
	| { kind: "preset"; layout: (typeof COMPOSITION_LAYOUTS)[number] }
	| { kind: "custom" }
	| { kind: "second"; id: string }
	| { kind: "alpha"; value: number }
	| { kind: "place"; rect: CompositionRect };

/** What the card and the designer send for each control. */
function wireInput(op: Op, live: boolean): StreamingSetConfigInput {
	const now = live ? { apply_now: true } : {};
	switch (op.kind) {
		case "enable":
			return {
				composition: {
					secondary_input_id: FIRST_CANDIDATE,
					layout: COMPOSITION_LAYOUT_DEFAULT,
					alpha: 1,
				},
			};
		case "disable":
			return { composition: null };
		case "preset":
			return { composition_patch: { layout: op.layout }, ...now };
		case "custom":
			return { composition_patch: { layout: "custom" }, ...now };
		case "second":
			return { composition_patch: { secondary_input_id: op.id }, ...now };
		case "alpha":
			return { composition_patch: { alpha: op.value }, ...now };
		case "place":
			return { composition_rect: op.rect, ...now };
	}
}

/** The reference model: each control's intent applied to the device's own state. */
function model(device: Composition, op: Op): Composition {
	if (op.kind === "enable")
		return {
			secondary_input_id: FIRST_CANDIDATE,
			layout: COMPOSITION_LAYOUT_DEFAULT,
			alpha: 1,
		};
	if (op.kind === "disable" || device === undefined) return undefined;
	const { rect: _rect, ...withoutRect } = device;
	switch (op.kind) {
		case "preset":
			return { ...withoutRect, layout: op.layout };
		case "custom":
			return {
				...device,
				layout: "custom",
				rect:
					device.layout === "custom" ? device.rect : presetRect(device.layout),
			};
		case "second":
			return { ...device, secondary_input_id: op.id };
		case "alpha":
			return { ...device, alpha: op.value };
		case "place":
			return { ...device, layout: "custom", rect: op.rect };
	}
}

function generator(seed: number): () => number {
	let state = seed >>> 0;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** A control the client's own view offers, as the card and the designer render it. */
function pickOp(
	view: Composition,
	live: boolean,
	next: () => number,
): Op | undefined {
	const pick = <T>(items: readonly T[]): T =>
		items[Math.floor(next() * items.length)] as T;
	if (view === undefined) return live ? undefined : { kind: "enable" };
	const kinds = ["preset", "second", "alpha", "place", "place"];
	if (view.layout !== "custom") kinds.push("custom");
	if (!live) kinds.push("disable");
	switch (pick(kinds)) {
		case "disable":
			return { kind: "disable" };
		case "preset":
			return { kind: "preset", layout: pick(COMPOSITION_LAYOUTS) };
		case "custom":
			return { kind: "custom" };
		case "second":
			return { kind: "second", id: pick(SECOND_INPUTS) };
		case "alpha":
			return { kind: "alpha", value: Math.round(next() * 20) / 20 };
		default: {
			const width = 1250 + Math.floor(next() * 8751);
			const height = 1250 + Math.floor(next() * 8751);
			return {
				kind: "place",
				rect: {
					x: Math.floor(next() * (10_001 - width)) / 10_000,
					y: Math.floor(next() * (10_001 - height)) / 10_000,
					width: width / 10_000,
					height: height / 10_000,
				},
			};
		}
	}
}

let directory: string;
let previousPath: string;
let previousConfig: ReturnType<typeof getConfig>;

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "composition-interleaving-"));
	previousPath = getConfigFilePath();
	previousConfig = structuredClone(getConfig());
	setConfigFilePath(join(directory, "config.json"));
	getConfig().composition = undefined;
	spyOn(defaultStagingDeps, "writeMarker").mockImplementation(() => {});
	spyOn(defaultStagingDeps, "removeMarker").mockImplementation(() => {});
	clearCapabilitiesCache();
	await initPipelines({
		fetchEngineCapabilities: async () => ({
			caps: CAPS,
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
});

afterEach(async () => {
	setApplyNowGateForTest(null);
	clearStagedConfigChange();
	spyOn(defaultStagingDeps, "writeMarker").mockRestore();
	spyOn(defaultStagingDeps, "removeMarker").mockRestore();
	clearCapabilitiesCache();
	for (const key of Object.keys(getConfig()))
		Reflect.deleteProperty(getConfig(), key);
	Object.assign(getConfig(), previousConfig);
	setConfigFilePath(previousPath);
	await rm(directory, { recursive: true, force: true });
});

for (const seed of [7, 1337, 20261115]) {
	test(`seed ${seed}: two clients with stale views, idle and live, always match the reference model`, async () => {
		const next = generator(seed);
		const views: [Composition, Composition] = [undefined, undefined];
		let device: Composition;
		let live = false;
		const engine: { refuses: boolean; saw: Composition | null } = {
			refuses: false,
			saw: null,
		};
		setApplyNowGateForTest({
			isStreamLive: () => live,
			dispatch: async (delta) => {
				engine.saw = delta.composition ?? undefined;
				return engine.refuses
					? { result: "reverted", attemptId: "step", reason: "change_rejected" }
					: { result: "applied", attemptId: "step" };
			},
		});
		let steps = 0;
		while (steps < 160) {
			if (next() < 0.1) live = !live;
			const client = next() < 0.5 ? 0 : 1;
			const op = pickOp(views[client], live, next);
			if (op === undefined) continue;
			engine.refuses = live && next() < 0.2;
			engine.saw = null;
			steps += 1;

			const result = await call(setConfigProcedure, wireInput(op, live), {
				context: makeRpcContext(),
			});
			const engineSaw = engine.saw as Composition | null;
			const refusedByEngine = live && engine.refuses && engineSaw !== null;
			const expected = refusedByEngine ? device : model(device, op);
			const step = { seed, steps, client, op, live, device, result };

			expect(getConfig().composition, JSON.stringify(step)).toEqual(expected);
			if (device === undefined && op.kind !== "enable" && op.kind !== "disable")
				expect(result, JSON.stringify(step)).toMatchObject({
					success: false,
					error: "composition_off",
				});
			if (engineSaw !== null)
				expect(engineSaw, JSON.stringify(step)).toEqual(model(device, op));

			device = getConfig().composition;
			views[client] = device;
			if (next() < 0.4) views[client === 0 ? 1 : 0] = device;
		}
	});
}
