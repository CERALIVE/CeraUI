import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import {
	PROTOCOL_VERSION,
	StatusSchema,
} from "../modules/remote-control/protocol.ts";
import {
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import { broadcastMsg, broadcastMsgExcept } from "../rpc/compat.ts";
import { addClient, removeClient } from "../rpc/events.ts";
import type { AppWebSocket } from "../rpc/types.ts";
import {
	AUTH_KEY,
	CID,
	collections,
	expectedBytes,
	expectNoPairingSecret,
	object,
	secrets,
	UNRELATED,
} from "./helpers/remote-privacy-cases.ts";
import { statusClient } from "./helpers/status-client.ts";

let localClient: AppWebSocket | undefined;
let now = 0;
beforeEach(() => {
	now += 60_000;
	spyOn(Date, "now").mockReturnValue(now);
});
afterEach(() => {
	if (localClient) removeClient(localClient);
	localClient = undefined;
	resetStatusRelay();
	mock.restore();
});

for (const row of collections) {
	for (const type of ["modems", "status"] as const) {
		for (const except of [false, true]) {
			test(`v2 ${type} ${except ? "except" : "ordinary"} wrapper preserves local bytes: ${row.name}`, () => {
				const payload = type === "modems" ? row.value : { modems: row.value };
				const before = JSON.stringify(payload);
				const frames: unknown[] = [];
				const localFrames: string[] = [];
				localClient = statusClient((frame) => localFrames.push(frame));
				addClient(localClient);
				setControlChannel({
					isConnected: () => true,
					sendFrame: (frame) => frames.push(frame),
				});
				const uuid = spyOn(crypto, "randomUUID").mockReturnValue(CID);
				try {
					if (except)
						broadcastMsgExcept(
							statusClient(() => {}),
							type,
							payload,
						);
					else broadcastMsg(type, payload);
				} finally {
					uuid.mockRestore();
				}

				expect(frames).toHaveLength(1);
				expect(localFrames).toHaveLength(1);
				const seq = JSON.parse(localFrames[0] ?? "").seq;
				expect(localFrames[0]).toBe(JSON.stringify({ [type]: payload, seq }));
				expect(JSON.stringify(frames[0])).toBe(
					expectedBytes(
						{
							v: PROTOCOL_VERSION,
							kind: "status",
							type,
							cid: CID,
							seq: 1,
							...(payload === undefined ? {} : { payload }),
						},
						undefined,
					),
				);
				expectNoPairingSecret(JSON.stringify(frames[0]));
				if (
					payload === undefined ||
					(object(payload) && !Array.isArray(payload))
				) {
					expect(StatusSchema.safeParse(frames[0]).success).toBe(true);
				}
				expect(JSON.stringify(payload)).toBe(before);
			});
		}
	}
}

for (const config of [
	{ first: 1, ...secrets, remote_key: AUTH_KEY, last: undefined },
	{
		ssh_pass: "",
		pairing_secret: undefined,
		srt_streamid: "",
		relay_streamid_override: undefined,
		nested: { password: UNRELATED },
	},
	{},
	[],
	null,
	undefined,
]) {
	for (const except of [false, true]) {
		test(`v2 config ${except ? "except" : "ordinary"} preserves exact remaining bytes: ${JSON.stringify(config)}`, () => {
			const frames: unknown[] = [];
			const before = JSON.stringify(config);
			const localFrames: string[] = [];
			localClient = statusClient((frame) => localFrames.push(frame));
			addClient(localClient);
			setControlChannel({
				isConnected: () => true,
				sendFrame: (frame) => frames.push(frame),
			});
			const uuid = spyOn(crypto, "randomUUID").mockReturnValue(CID);
			try {
				if (except)
					broadcastMsgExcept(
						statusClient(() => {}),
						"config",
						config,
					);
				else broadcastMsg("config", config);
			} finally {
				uuid.mockRestore();
			}

			expect(frames).toHaveLength(1);
			expect(localFrames).toHaveLength(1);
			const seq = JSON.parse(localFrames[0] ?? "").seq;
			expect(localFrames[0]).toBe(JSON.stringify({ config, seq }));
			expect(JSON.stringify(frames[0])).toBe(
				expectedBytes(
					{
						v: PROTOCOL_VERSION,
						kind: "status",
						type: "config",
						cid: CID,
						seq: 1,
						...(config === undefined ? {} : { payload: config }),
					},
					config,
				),
			);
			expectNoPairingSecret(JSON.stringify(frames[0]));
			expect(JSON.stringify(config)).toBe(before);
		});
	}
}
