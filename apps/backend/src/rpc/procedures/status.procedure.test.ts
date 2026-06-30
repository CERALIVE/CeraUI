import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";

import { initMockService } from "../../mocks/mock-service.ts";
import { setup } from "../../modules/setup.ts";
import type { AppWebSocket, RPCContext } from "../types.ts";
import { getStatusProcedure } from "./status.procedure.ts";

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

// Regression for the reconnect re-auth "Output validation failed" loop: on a
// reconnect the frontend re-hydrates via the `status.getStatus` RPC (unlike the
// initial connect, which uses an unvalidated broadcast). `available_updates`
// defaults to the falsy sentinel `false`/`null`, which the output schema must
// accept — a schema that only allowed the package-summary object rejected the
// whole getStatus reply and broke reconnect hydration.
describe("status.getStatus — output validation (reconnect re-auth path)", () => {
	const savedMockMode = process.env.MOCK_MODE;
	const savedNodeEnv = process.env.NODE_ENV;
	// getStatus calls getSshStatus, which throws on an invalid setup.ssh_user.
	// Other suites mutate the shared `setup` object without restoring it, so pin
	// a valid user here to keep this test order-independent.
	const savedSshUser = setup.ssh_user;

	beforeAll(() => {
		process.env.NODE_ENV = "development";
		process.env.MOCK_MODE = "true";
		setup.ssh_user = "ceralive";
		initMockService(process.env.MOCK_SCENARIO || "multi-modem-wifi");
	});

	afterAll(() => {
		setup.ssh_user = savedSshUser;
		if (savedMockMode === undefined) delete process.env.MOCK_MODE;
		else process.env.MOCK_MODE = savedMockMode;
		if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
		else process.env.NODE_ENV = savedNodeEnv;
	});

	test("getStatus reply passes its output schema with no updates available", async () => {
		const result = await call(getStatusProcedure, undefined, {
			context: makeContext(),
		});
		expect(statusResponseSchema.safeParse(result).success).toBe(true);
	});
});
