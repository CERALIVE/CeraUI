import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { modemConfigOutputSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService, stopMockService } from "../mocks/mock-service.ts";
import { configureModemProcedure } from "../rpc/procedures/modems.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

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

describe("modems.configure — applied echo", () => {
	let priorMockMode: string | undefined;

	beforeAll(() => {
		priorMockMode = process.env.MOCK_MODE;
		process.env.MOCK_MODE = "true";
		initMockService("multi-modem-wifi");
	});

	afterAll(() => {
		stopMockService();
		if (priorMockMode === undefined) {
			delete process.env.MOCK_MODE;
		} else {
			process.env.MOCK_MODE = priorMockMode;
		}
	});

	test("echoes the persisted post-normalisation config in `applied`", async () => {
		const result = await call(
			configureModemProcedure,
			{
				device: "0",
				network_type: "4g",
				roaming: true,
				network: "310260",
				autoconfig: false,
				apn: "internet",
				username: "user",
				password: "secret",
			},
			{ context: makeContext() },
		);

		const parsed = modemConfigOutputSchema.safeParse(result);
		expect(parsed.success).toBe(true);
		expect(result.success).toBe(true);
		expect(result.applied).toEqual({
			device: "0",
			network_type: "4g",
			roaming: true,
			network: "310260",
			autoconfig: false,
			apn: "internet",
			username: "user",
			password: "secret",
		});
	});

	test("normalises absent optionals in `applied` (roaming/network/autoconfig default)", async () => {
		const result = await call(
			configureModemProcedure,
			{
				device: "1",
				network_type: "5g",
				autoconfig: true,
				apn: "",
				username: "",
				password: "",
			},
			{ context: makeContext() },
		);

		expect(result.success).toBe(true);
		expect(result.applied).toEqual({
			device: "1",
			network_type: "5g",
			roaming: false,
			network: "",
			autoconfig: true,
			apn: "",
			username: "",
			password: "",
		});
	});
});
