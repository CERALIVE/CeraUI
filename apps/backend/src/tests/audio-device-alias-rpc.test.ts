/*
 * `streaming.setAudioDeviceAlias` — the single mutation path for operator-assigned
 * audio-device display names (device-quality-wave2).
 *
 * Coverage:
 *   (a) runtimeConfigSchema round-trips `audio_device_aliases`; an absent key parses.
 *   (b) the RPC persists (saveConfig), echoes `config`, and rebroadcasts `status`.
 *   (c) an empty label CLEARS the alias (the operator's "reset to hardware name").
 *   (d) presentation-only: a rename never touches `asrc`.
 *   + single-mutation-path discipline: `setConfig` strips an `audio_device_aliases`
 *     field, so a generic config write can never rename a device.
 *   + malformed input rejected by Zod with a structured error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
	AUDIO_DEVICE_ALIAS_MAX_LENGTH,
	setAudioDeviceAliasInputSchema,
	streamingConfigInputSchema,
} from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { runtimeConfigSchema } from "../helpers/config-schemas.ts";
import { getConfig } from "../modules/config.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import { appRouter } from "../rpc/router.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const RODE_KEY = "card:usbaudio";
const DJI_KEY = "card:MINI";

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

function makeRecordingClient(
	sink: Array<Record<string, unknown>>,
): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send: (msg: string) => {
			try {
				sink.push(JSON.parse(msg) as Record<string, unknown>);
			} catch {
				// non-JSON frame — irrelevant here
			}
		},
	} as unknown as AppWebSocket;
}

async function setAlias(alias_key: string, label: string) {
	return call(
		appRouter.streaming.setAudioDeviceAlias,
		{ alias_key, label },
		{ context: makeContext() },
	);
}

// ─── (a) schema round-trip ────────────────────────────────────────────────────

describe("audio_device_aliases — runtimeConfigSchema", () => {
	test("an absent key parses (legacy config)", () => {
		const parsed = runtimeConfigSchema.parse({});
		expect(parsed.audio_device_aliases).toBeUndefined();
	});

	test("round-trips a stable-id-keyed alias map", () => {
		const parsed = runtimeConfigSchema.parse({
			audio_device_aliases: { [DJI_KEY]: "Presenter mic" },
		});
		expect(parsed.audio_device_aliases).toEqual({ [DJI_KEY]: "Presenter mic" });
	});

	test("rejects a label past the max length", () => {
		const result = runtimeConfigSchema.safeParse({
			audio_device_aliases: {
				[DJI_KEY]: "x".repeat(AUDIO_DEVICE_ALIAS_MAX_LENGTH + 1),
			},
		});
		expect(result.success).toBe(false);
	});
});

// ─── (b)-(d) RPC persist + rebroadcast ────────────────────────────────────────

describe("streaming.setAudioDeviceAlias RPC", () => {
	beforeEach(() => {
		delete (getConfig() as { audio_device_aliases?: unknown })
			.audio_device_aliases;
	});
	afterEach(() => {
		delete (getConfig() as { audio_device_aliases?: unknown })
			.audio_device_aliases;
	});

	test("persists the alias, echoes config, and rebroadcasts the audio status", async () => {
		const sink: Array<Record<string, unknown>> = [];
		const client = makeRecordingClient(sink);
		addClient(client);
		try {
			const res = await setAlias(DJI_KEY, "Presenter mic");
			expect(res).toEqual({
				success: true,
				applied: { alias_key: DJI_KEY, label: "Presenter mic" },
			});
			expect(getConfig().audio_device_aliases).toEqual({
				[DJI_KEY]: "Presenter mic",
			});

			const configFrame = sink.find((m) => "config" in m);
			expect(
				(configFrame?.config as Record<string, unknown>).audio_device_aliases,
			).toEqual({ [DJI_KEY]: "Presenter mic" });

			// A fresh `status` frame carrying the audio surface was broadcast, so the
			// rename lands live without waiting for a hotplug re-enumeration tick.
			const statusFrame = sink.find(
				(m) =>
					"status" in m &&
					"audio_sources" in (m.status as Record<string, unknown>),
			);
			expect(statusFrame).toBeDefined();
		} finally {
			removeClient(client);
		}
	});

	test("trims the stored label", async () => {
		const res = await setAlias(DJI_KEY, "  Presenter mic  ");
		expect(res.applied?.label).toBe("Presenter mic");
		expect(getConfig().audio_device_aliases?.[DJI_KEY]).toBe("Presenter mic");
	});

	test("an empty label CLEARS the alias (reset to the hardware name)", async () => {
		await setAlias(DJI_KEY, "Presenter mic");
		const res = await setAlias(DJI_KEY, "");
		expect(res.success).toBe(true);
		expect(res.applied?.label).toBeUndefined();
		expect(getConfig().audio_device_aliases).toEqual({});
	});

	test("a whitespace-only label also clears", async () => {
		await setAlias(DJI_KEY, "Presenter mic");
		await setAlias(DJI_KEY, "   ");
		expect(getConfig().audio_device_aliases).toEqual({});
	});

	test("renaming one device leaves every other alias intact", async () => {
		await setAlias(RODE_KEY, "Camera A");
		await setAlias(DJI_KEY, "Presenter mic");
		expect(getConfig().audio_device_aliases).toEqual({
			[RODE_KEY]: "Camera A",
			[DJI_KEY]: "Presenter mic",
		});

		await setAlias(DJI_KEY, "");
		expect(getConfig().audio_device_aliases).toEqual({
			[RODE_KEY]: "Camera A",
		});
	});

	test("a rename NEVER touches config.asrc (presentation-only)", async () => {
		const config = getConfig();
		config.asrc = "USB audio";
		await setAlias(RODE_KEY, "Camera A");
		expect(getConfig().asrc).toBe("USB audio");
	});
});

// ─── mutation-path discipline + validation ────────────────────────────────────

describe("audio_device_aliases — mutation-path discipline + validation", () => {
	test("streaming.setConfig STRIPS an audio_device_aliases field", () => {
		const parsed = streamingConfigInputSchema.parse({
			max_br: 6000,
			audio_device_aliases: { [DJI_KEY]: "Sneaky rename" },
		});
		expect("audio_device_aliases" in parsed).toBe(false);
		expect(parsed.max_br).toBe(6000);
	});

	test("rejects an empty alias_key with a structured Zod error", () => {
		const result = setAudioDeviceAliasInputSchema.safeParse({
			alias_key: "",
			label: "Presenter mic",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.path).toEqual(["alias_key"]);
		}
	});

	test("rejects a label past the max length", () => {
		const result = setAudioDeviceAliasInputSchema.safeParse({
			alias_key: DJI_KEY,
			label: "x".repeat(AUDIO_DEVICE_ALIAS_MAX_LENGTH + 1),
		});
		expect(result.success).toBe(false);
	});
});
