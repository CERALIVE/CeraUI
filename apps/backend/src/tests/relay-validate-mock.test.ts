/*
 * Task 4 — deterministic relay.validate mock seam (test-infra only, NOT egress).
 *
 * Proves the mock short-circuit in relay.procedure.ts:
 *   - in mock mode a well-formed input returns { valid:true, stage:"probe" }
 *     even for an UNRESOLVABLE host (RFC-6761 `.invalid`), which the real path
 *     would have rejected at the `dns` stage — so the dns+probe network stages
 *     were bypassed without a network call.
 *   - a forced fault makes the named network stage fail deterministically.
 *   - the input/protocol/endpoint adapter checks run BEFORE the seam, so a
 *     malformed input still fails at its real stage.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
} from "bun:test";

import { call } from "@orpc/server";
import {
	initMockService,
	resetMockState,
	setMockRelayValidateFault,
	stopMockService,
} from "../mocks/mock-service.ts";
import { relayValidateProcedure } from "../rpc/procedures/relay.procedure.ts";
import type { AppWebSocket, RPCContext } from "../rpc/types.ts";

const SCENARIO = "multi-modem-wifi";
const ORIGINAL_MOCK_MODE = process.env.MOCK_MODE;

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

const validate = (input: {
	addr: string;
	port: number;
	streamid?: string;
	protocol?: "srtla" | "srt" | "rist";
}) => call(relayValidateProcedure, input, { context: makeContext() });

beforeAll(() => {
	// shouldUseMocks() gates the seam on isDevelopment(); MOCK_MODE flips that on
	// without depending on NODE_ENV.
	process.env.MOCK_MODE = "true";
	initMockService(SCENARIO);
});

afterEach(() => resetMockState());

afterAll(() => {
	stopMockService();
	if (ORIGINAL_MOCK_MODE === undefined) {
		delete process.env.MOCK_MODE;
	} else {
		process.env.MOCK_MODE = ORIGINAL_MOCK_MODE;
	}
});

describe("relay.validate deterministic mock seam (Task 4)", () => {
	it("returns a successful probe for well-formed input without a network call", async () => {
		// `*.invalid` is guaranteed-unresolvable (RFC 6761): the real dns stage
		// would fail here, so a successful probe proves the seam bypassed it.
		const result = await validate({ addr: "relay.invalid", port: 9000 });

		expect(result).toEqual({ valid: true, stage: "probe" });
	});

	it("forces a failing probe stage from the fixture", async () => {
		setMockRelayValidateFault({ stage: "probe", reason: "forced timeout" });

		const result = await validate({ addr: "relay.invalid", port: 9000 });

		expect(result).toEqual({
			valid: false,
			stage: "probe",
			reason: "forced timeout",
		});
	});

	it("forces a failing dns stage from the fixture", async () => {
		setMockRelayValidateFault({ stage: "dns", reason: "forced NXDOMAIN" });

		const result = await validate({ addr: "relay.invalid", port: 9000 });

		expect(result).toEqual({
			valid: false,
			stage: "dns",
			reason: "forced NXDOMAIN",
		});
	});

	it("still fails at the input stage for a blank address (adapter checks intact)", async () => {
		setMockRelayValidateFault({ stage: "probe", reason: "should not be reached" });

		const result = await validate({ addr: "   ", port: 9000 });

		expect(result.valid).toBe(false);
		expect(result.stage).toBe("input");
	});

	it("still fails at the endpoint stage for an odd RIST data port (adapter checks intact)", async () => {
		setMockRelayValidateFault({ stage: "probe", reason: "should not be reached" });

		const result = await validate({
			addr: "relay.invalid",
			port: 1935,
			protocol: "rist",
		});

		expect(result.valid).toBe(false);
		expect(result.stage).toBe("endpoint");
	});
});
