/**
 * `modems.setUsbMode` gate contract.
 *
 * A USB-composition switch re-enumerates the modem and drops its bond link, so
 * the gates below are the safety contract rather than UI polish — each is driven
 * through the REAL procedure so a direct RPC call is covered, not just a hidden
 * control. The transition transaction itself is a later wave; what is pinned here
 * is that NO path answers success, and that each refusal names its own cause.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { call } from "@orpc/server";

import { getConfig } from "../modules/config.ts";
import { updateStatus } from "../modules/streaming/streaming.ts";
import { withDeviceType } from "../modules/system/device-detection.ts";
import { setUsbModeProcedure } from "../rpc/procedures/modems.procedure.ts";
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

const REQUEST = { device: "0", mode: "qmi", confirm: true } as const;

function provision(enabled: boolean | undefined): void {
	if (enabled === undefined) {
		delete getConfig().modem_provisioning;
		return;
	}
	getConfig().modem_provisioning = enabled;
}

afterEach(() => {
	provision(undefined);
	updateStatus(false);
});

describe("modems.setUsbMode gates", () => {
	test("an unprovisioned device refuses, and that is the DEFAULT", () => {
		expect(getConfig().modem_provisioning).toBeUndefined();

		return withDeviceType("real", async () => {
			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "provisioning_disabled",
			});
		});
	});

	test("an explicit false refuses exactly like an absent key", () =>
		withDeviceType("real", async () => {
			provision(false);

			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "provisioning_disabled",
			});
		}));

	test("the provisioning gate outranks every other condition", () =>
		withDeviceType("emulated", async () => {
			updateStatus(true);

			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "provisioning_disabled",
			});
		}));

	test("a provisioned dev host refuses as emulated, never as busy", () =>
		withDeviceType("emulated", async () => {
			provision(true);
			updateStatus(true);

			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "unavailable_in_emulated_mode",
			});
		}));

	test("a live stream refuses the transition", () =>
		withDeviceType("real", async () => {
			provision(true);
			updateStatus(true);

			expect(
				await call(setUsbModeProcedure, REQUEST, { context: makeContext() }),
			).toEqual({
				success: false,
				error: "streaming_active",
			});
		}));

	test("past every gate the answer is transition_failed, never success", () =>
		withDeviceType("real", async () => {
			provision(true);

			const result = await call(setUsbModeProcedure, REQUEST, {
				context: makeContext(),
			});

			expect(result.success).toBe(false);
			expect(result.error).toBe("transition_failed");
		}));

	test("a request missing `confirm` never reaches the handler", () =>
		withDeviceType("real", async () => {
			provision(true);

			await expect(
				call(setUsbModeProcedure, { device: "0", mode: "qmi" } as never, {
					context: makeContext(),
				}),
			).rejects.toThrow();
		}));

	test("an unknown extra key never reaches the handler", () =>
		withDeviceType("real", async () => {
			provision(true);

			await expect(
				call(setUsbModeProcedure, { ...REQUEST, force: true } as never, {
					context: makeContext(),
				}),
			).rejects.toThrow();
		}));
});
