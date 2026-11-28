import { afterEach, expect, test } from "bun:test";
import type {
	CerastreamClient,
	EventParams,
	GetCapabilitiesResult,
} from "@ceralive/cerastream";
import { SCHEMA_VERSION, statusEventSchema } from "@ceralive/cerastream";
import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	clearCapabilitiesCache,
	getCapabilities,
} from "../modules/streaming/capabilities.ts";
import { CerastreamBackend } from "../modules/streaming/cerastream-backend.ts";

const config: RuntimeConfig = {
	pipeline: "test",
	max_br: 2000,
	failover_rate_policy: "adapt",
};
const caps: GetCapabilitiesResult = {
	platform: {
		supports_h265: true,
		hardware_accelerated: true,
		max_resolution: "1920x1080",
	},
	encoder: {
		codecs: ["h264"],
		bitrate_range: { min: 500, max: 8000, unit: "kbps" },
	},
	sources: [],
};

async function setup(features: string[], holdStart?: () => Promise<void>) {
	await getCapabilities({
		fetchEngineCapabilities: async () => ({
			caps: { ...caps, features },
			schemaVersion: SCHEMA_VERSION,
		}),
		fetchEngineDevices: async () => ({ devices: [] }),
	});
	const calls: Array<{ method: string; params: unknown }> = [];
	let publish: ((event: EventParams) => void) | undefined;
	const client = {
		hello: { schema_version: SCHEMA_VERSION },
		getCapabilities: async () => ({ ...caps, features }),
		subscribeEvents: async (
			_params: unknown,
			handler: (event: EventParams) => void,
		) => {
			publish = handler;
			return { result: { topics: [] }, close: () => {} };
		},
		rawRequest: async (method: string, params: unknown) => {
			calls.push({ method, params });
			if (method === "start") await holdStart?.();
			return { session_id: "one", state: "streaming" };
		},
		reloadConfig: async (params: unknown) => {
			calls.push({ method: "reload-config", params });
			return { applied: params };
		},
		close: async () => {},
	} as unknown as CerastreamClient;
	const backend = new CerastreamBackend({
		connect: async () => client,
		getConfig: () => config,
	});
	return { backend, calls, publish: (event: EventParams) => publish?.(event) };
}

afterEach(() => {
	config.failover_rate_policy = "adapt";
	clearCapabilitiesCache();
});

test("failover_rate_policy is sent on start only when the engine advertises its feature", async () => {
	for (const features of [[], ["failover-rate-policy"]]) {
		const h = await setup(features);
		await h.backend.start(config, {
			pipeline: "test",
			host: "127.0.0.1",
			port: 9000,
			streamid: "",
		});
		await h.backend.settle();
		const start = h.calls.find((call) => call.method === "start");
		if (features.length)
			expect(start?.params).toMatchObject({ failover_rate_policy: "adapt" });
		else expect(start?.params).not.toHaveProperty("failover_rate_policy");
	}
});

test("the live policy reload waits for Start and does not resend next-start settings", async () => {
	const entered = Promise.withResolvers<void>();
	const acknowledge = Promise.withResolvers<void>();
	const h = await setup(["failover-rate-policy"], async () => {
		entered.resolve();
		await acknowledge.promise;
	});
	const starting = h.backend.start(
		{ ...config },
		{
			pipeline: "test",
			host: "127.0.0.1",
			port: 9000,
			streamid: "",
		},
	);
	await entered.promise;
	config.failover_rate_policy = "retime";
	const heartbeat = statusEventSchema.parse({
		type: "status",
		seq: 1,
		state: "streaming",
		streaming: true,
		active_encode: {
			codec: "h264",
			resolution: "1920x1080",
			framerate: 30,
			capture: {
				state: "normal",
				live_inputs: ["camera-a"],
				degraded_inputs: [],
				failover_rate_policy: "adapt",
			},
		},
	});
	try {
		h.publish(heartbeat);
	} finally {
		acknowledge.resolve();
	}
	await starting;
	await h.backend.settle();
	expect(h.calls.filter((call) => call.method === "reload-config")).toEqual([]);

	h.publish(heartbeat);
	await h.backend.settle();
	expect(
		h.calls.filter((call) => call.method === "reload-config"),
	).toHaveLength(1);
	expect(h.calls[h.calls.length - 1]?.params).toEqual({
		failover_rate_policy: "retime",
	});
	h.publish(heartbeat);
	await h.backend.settle();
	expect(
		h.calls.filter((call) => call.method === "reload-config"),
	).toHaveLength(1);
	expect(h.calls.filter((call) => call.method === "start")).toHaveLength(1);
});
