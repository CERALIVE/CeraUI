/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * Phase B, T5.4 — the `modem_provisioning` default-absent USB-mode gate.
 *
 * Acceptance: while `modem_provisioning` is absent (the default state) the guarded
 * `modems.setUsbMode` mutation is UNREACHABLE — a direct RPC call is refused with
 * the typed `provisioning_disabled` error, never a crash and never a silent
 * success. Setting the key to `true` lifts the gate (the mutation then reaches the
 * still-unimplemented transition transaction, which is a later wave, so the
 * emulated-mode refusal is expected here).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SetUsbModeInput } from "@ceraui/rpc/schemas";
import { call } from "@orpc/server";
import { resetCellularStack } from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import { resetBootReadiness } from "../modules/system/readiness.ts";
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

const VALID_INPUT: SetUsbModeInput = {
	device: "0",
	mode: "mbim",
	confirm: true,
};

async function callSetUsbMode(input: unknown): Promise<unknown> {
	return call(setUsbModeProcedure, input as SetUsbModeInput, {
		context: makeContext(),
	});
}

describe("modems.setUsbMode — modem_provisioning default-absent gate", () => {
	beforeEach(() => {
		resetCellularStack();
		resetBootReadiness();
		getConfig().modem_provisioning = undefined;
	});

	afterEach(() => {
		resetCellularStack();
		resetBootReadiness();
		getConfig().modem_provisioning = undefined;
	});

	test("modem_provisioning ABSENT → typed provisioning_disabled refusal (not a crash)", async () => {
		// Given no modem_provisioning key (the default for every existing device)
		expect(getConfig().modem_provisioning).toBeUndefined();
		// When setUsbMode is called directly over RPC
		const result = await callSetUsbMode(VALID_INPUT);
		// Then it is a typed refusal — the mutation is unreachable
		expect(result).toEqual({ success: false, error: "provisioning_disabled" });
	});

	test("modem_provisioning === false → still provisioning_disabled", async () => {
		getConfig().modem_provisioning = false;
		const result = await callSetUsbMode(VALID_INPUT);
		expect(result).toEqual({ success: false, error: "provisioning_disabled" });
	});

	test("modem_provisioning === true (emulated host) → past the gate, emulated refusal", async () => {
		// Given the operator opted in but this is an emulated/dev host
		getConfig().modem_provisioning = true;
		// When setUsbMode is called
		const result = await callSetUsbMode(VALID_INPUT);
		// Then it clears the provisioning gate and hits the emulated-mode refusal —
		// proving the gate is the ONLY thing that returns provisioning_disabled.
		expect(result).toEqual({
			success: false,
			error: "unavailable_in_emulated_mode",
		});
	});

	test("missing confirm:true is rejected at the input boundary (strict schema)", async () => {
		getConfig().modem_provisioning = true;
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: exercising an invalid payload
			callSetUsbMode({ device: "0", mode: "mbim" } as any),
		).rejects.toThrow();
	});

	test("an unknown extra field is rejected (.strict input)", async () => {
		getConfig().modem_provisioning = true;
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: exercising an invalid payload
			callSetUsbMode({ ...VALID_INPUT, rogue: 1 } as any),
		).rejects.toThrow();
	});
});
