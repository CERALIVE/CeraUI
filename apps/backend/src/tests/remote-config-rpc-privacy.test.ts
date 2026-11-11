import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { call } from "@orpc/server";
import * as mockService from "../mocks/mock-service.ts";
import { getConfig, getConfigFilePath } from "../modules/config.ts";
import { routeCommand } from "../modules/remote-control/command-router.ts";
import { buildControlContext } from "../modules/remote-control/control-context.ts";
import {
	PROTOCOL_VERSION,
	type Result,
	ResultSchema,
} from "../modules/remote-control/protocol.ts";
import { getConfigProcedure } from "../rpc/procedures/streaming.procedure.ts";
import {
	AUTH_KEY,
	CID,
	expectedBytes,
	expectNoPairingSecret,
	object,
	secrets,
} from "./helpers/remote-privacy-cases.ts";
import { usePrivacyConfig } from "./helpers/remote-privacy-config.ts";

usePrivacyConfig();
beforeEach(() => {
	spyOn(mockService, "shouldUseMocks").mockReturnValue(false);
});
afterEach(() => {
	mock.restore();
});

test("actual remote streaming.getConfig preserves media keys and preserves local RPC bytes and remote authentication", async () => {
	const context = buildControlContext();
	const local = await call(getConfigProcedure, undefined, { context });
	const before = JSON.stringify(local);
	const frames: Result[] = [];

	await routeCommand(
		{
			v: PROTOCOL_VERSION,
			kind: "command",
			type: "streaming.getConfig",
			role: "owner",
			cid: CID,
		},
		{
			sendResult: (frame) => {
				frames.push(frame);
				return true;
			},
		},
	);

	expect(frames).toHaveLength(1);
	expect(JSON.stringify(frames[0])).toBe(
		expectedBytes(
			{
				v: PROTOCOL_VERSION,
				kind: "result",
				type: "streaming.getConfig",
				cid: CID,
				role: "owner",
				payload: { ok: true, applied: local },
			},
			local,
		),
	);
	expectNoPairingSecret(JSON.stringify(frames));
	expect(JSON.stringify(frames)).toContain(AUTH_KEY);
	expect(ResultSchema.safeParse(frames[0]).success).toBe(true);
	expect(
		JSON.stringify(await call(getConfigProcedure, undefined, { context })),
	).toBe(before);
	expect(before).toContain(secrets.srt_streamid);
	expect(before).toContain(secrets.relay_streamid_override);
});

for (const destination of ["custom", "managed"] as const) {
	test(`remote latency-only ${destination} save preserves its persisted media credential`, async () => {
		const { buildServerSetConfig } = await import(
			"../../../frontend/src/lib/streaming/receiver-experience.ts"
		);
		const config = getConfig();
		config.srtla_addr = "relay.example.test";
		config.srtla_port = 5000;
		config.relay_server = destination === "managed" ? "saved-relay" : undefined;
		const frames: Result[] = [];
		const sink = {
			sendResult: (frame: Result) => {
				frames.push(frame);
				return true;
			},
		};
		await routeCommand(
			{
				v: PROTOCOL_VERSION,
				kind: "command",
				type: "streaming.getConfig",
				role: "owner",
				cid:
					destination === "custom"
						? "0505b656-e9ba-4663-8fb6-0fd7bfe6cd48"
						: "0505b656-e9ba-4663-8fb6-0fd7bfe6cd49",
			},
			sink,
		);
		const remoteConfig = frames[0]?.payload.applied;
		if (!object(remoteConfig)) throw new Error("missing remote config");
		const payload = buildServerSetConfig(
			{
				latency: 3000,
				protocol: "srtla",
				addr: String(remoteConfig.srtla_addr ?? ""),
				portStr: String(remoteConfig.srtla_port ?? ""),
				streamId:
					typeof remoteConfig.srt_streamid === "string"
						? remoteConfig.srt_streamid
						: "",
				relayStreamId:
					typeof remoteConfig.relay_streamid_override === "string"
						? remoteConfig.relay_streamid_override
						: "",
				relayServer:
					typeof remoteConfig.relay_server === "string"
						? remoteConfig.relay_server
						: "",
				relayAccount: "",
			},
			{ destination },
		);
		await routeCommand(
			{
				v: PROTOCOL_VERSION,
				kind: "command",
				type: "streaming.setConfig",
				role: "owner",
				cid:
					destination === "custom"
						? "480414b0-688d-4477-bdb6-414cae5bc867"
						: "480414b0-688d-4477-bdb6-414cae5bc868",
				payload,
			},
			sink,
		);
		expect(frames.at(-1)?.payload.ok).toBe(true);
		expect(config.srt_latency).toBe(3000);
		const key =
			destination === "custom" ? "srt_streamid" : "relay_streamid_override";
		expect(config[key]).toBe(secrets[key]);
		expect(JSON.parse(await readFile(getConfigFilePath(), "utf8"))[key]).toBe(
			secrets[key],
		);
	});
}
