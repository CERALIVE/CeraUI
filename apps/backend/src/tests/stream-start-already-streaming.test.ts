import { afterEach, describe, expect, test } from "bun:test";
import {
	CerastreamRpcError,
	CerastreamTimeoutError,
} from "@ceralive/cerastream";
import { startRefusedAsAlreadyStreaming } from "../modules/streaming/cerastream-backend.ts";
import { evidenceHarness } from "./helpers/stream-engine-evidence.ts";

const fixtures: ReturnType<typeof evidenceHarness>[] = [];
const harness = (schemaVersion?: string) => {
	const h = evidenceHarness(false, { schemaVersion });
	fixtures.push(h);
	return h;
};
afterEach(() => {
	for (const h of fixtures.splice(0)) h.dispose();
});

const engineCalls = (h: ReturnType<typeof evidenceHarness>, call: string) =>
	h.clients.flatMap(({ calls }) => calls).filter((made) => made === call);

describe("a Start refused because another session is running", () => {
	for (const [label, dataCode, schemaVersion, startCall] of [
		["typed", "cerastream.state.already_streaming", undefined, "start"],
		["numeric only", undefined, undefined, "start"],
		// Schema 0.6 and later send Start as a raw request.
		["raw request", "cerastream.state.already_streaming", "0.6.0", "raw:start"],
	] as const) {
		test(`${label}: the rollback leaves the running session alone`, async () => {
			const h = harness(schemaVersion);
			h.beforeStartDispatch(() => {
				// Admitted idle, then another client starts a session first.
				h.setEngine("streaming");
				h.refuseStart(-32002, dataCode);
			});

			expect(await h.start()).toMatchObject({
				result: "failed",
				failure: { phase: "start-rpc" },
			});

			expect(engineCalls(h, startCall)).toHaveLength(1);
			expect(engineCalls(h, "stop")).toHaveLength(0);
			expect(h.view()).toMatchObject({
				engine: "streaming",
				state: "reconciling",
			});
			// The orchestrator's own verdict, not the harness's OTA mark.
			expect(h.session.streamLiveness()).toBe("unknown");
			// The Start's own connection is still released.
			expect(h.clients[0]?.calls).toContain("close");
		});
	}

	test("the operator's Stop still ends it", async () => {
		const h = harness();
		h.beforeStartDispatch(() => {
			h.setEngine("streaming");
			h.refuseStart(-32002, "cerastream.state.already_streaming");
		});
		await h.start();

		expect(await h.session.stop("operator")).toEqual({ result: "stopped" });

		expect(engineCalls(h, "stop")).toHaveLength(1);
		expect(h.view()).toMatchObject({
			engine: "idle",
			state: "idle",
			marked: false,
		});
	});

	test("any other refusal after dispatch still rolls back with a Stop", async () => {
		const h = harness();
		h.beforeStartDispatch(() => {
			h.refuseStart(-32603, "cerastream.internal");
		});

		expect(await h.start()).toMatchObject({ result: "failed" });

		expect(engineCalls(h, "stop")).toHaveLength(1);
		expect(h.view()).toMatchObject({ engine: "idle", state: "idle" });
	});
});

describe("startRefusedAsAlreadyStreaming", () => {
	test.each([
		[
			new CerastreamRpcError(
				-32002,
				"m",
				"cerastream.state.already_streaming",
				1,
			),
			true,
		],
		[new CerastreamRpcError(-32002, "m", undefined, 1), true],
		// A typed code wins over the number.
		[new CerastreamRpcError(-32002, "m", "cerastream.internal", 1), false],
		[
			new CerastreamRpcError(
				-32603,
				"m",
				"cerastream.state.already_streaming",
				1,
			),
			true,
		],
		[new CerastreamRpcError(-32001, "m", undefined, 1), false],
		[new CerastreamTimeoutError("start", 10_000), false],
		[new Error("already_streaming"), false],
	])("%p → %p", (error, expected) => {
		expect(startRefusedAsAlreadyStreaming(error)).toBe(expected);
	});
});
