import { afterEach, expect, spyOn, test } from "bun:test";
import { projectRemoteStatus } from "../modules/remote/remote-status.ts";
import {
	PROTOCOL_VERSION,
	StatusSchema,
} from "../modules/remote-control/protocol.ts";
import {
	relayStatusToGateway,
	resetStatusRelay,
	setControlChannel,
} from "../modules/remote-control/status-relay.ts";
import {
	HOTSPOT_PASSWORD,
	OTHER_PASSWORD,
	remoteStatusCases,
} from "./helpers/remote-status-cases.ts";

afterEach(() => {
	resetStatusRelay();
});

for (const row of remoteStatusCases) {
	test(`projection preserves containers, undefined values and order: ${row.name}`, () => {
		const local = {
			first: "status-first",
			wifi: row.local,
			modems: { lte: { config: { password: OTHER_PASSWORD } } },
			last: undefined,
		};
		const expected = {
			...local,
			wifi: row.remote,
		};
		const original = structuredClone(local);

		const remote = projectRemoteStatus(local);

		expect(remote).toStrictEqual(expected);
		expect(JSON.stringify(remote)).toBe(JSON.stringify(expected));
		expect(JSON.stringify(remote)?.includes(HOTSPOT_PASSWORD) ?? false).toBe(
			JSON.stringify(row.local)?.includes(HOTSPOT_PASSWORD) ?? false,
		);
		expect(JSON.stringify(remote)).toContain(OTHER_PASSWORD);
		expect(local).toStrictEqual(original);
	});

	test(`v2 serialized frame preserves credentials and exact shape: ${row.name}`, () => {
		const frames: unknown[] = [];
		const cid = "00000000-0000-4000-8000-000000000001";
		const uuid = spyOn(crypto, "randomUUID").mockReturnValue(cid);
		const local = {
			first: "status-first",
			wifi: row.local,
			modems: { lte: { config: { password: OTHER_PASSWORD } } },
			last: undefined,
		};
		const original = structuredClone(local);
		setControlChannel({
			isConnected: () => true,
			sendFrame: (frame) => frames.push(frame),
		});
		try {
			relayStatusToGateway("status", local, 7);
		} finally {
			uuid.mockRestore();
		}

		expect(frames).toHaveLength(1);
		expect(JSON.stringify(frames[0])).toBe(
			JSON.stringify({
				v: PROTOCOL_VERSION,
				kind: "status",
				type: "status",
				cid,
				seq: 7,
				payload: {
					...local,
					wifi: row.remote,
				},
			}),
		);
		expect(JSON.stringify(frames[0]).includes(HOTSPOT_PASSWORD)).toBe(
			JSON.stringify(row.local)?.includes(HOTSPOT_PASSWORD) ?? false,
		);
		expect(StatusSchema.parse(frames[0]).payload).toStrictEqual({
			...local,
			wifi: row.remote,
		});
		expect(local).toStrictEqual(original);
	});
}

test("an undefined status payload stays undefined", () => {
	expect(projectRemoteStatus(undefined)).toBeUndefined();
});
