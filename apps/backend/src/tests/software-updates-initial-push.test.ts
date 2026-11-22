import { afterEach, describe, expect, test } from "bun:test";

import {
	recoverSoftwareUpdateIfRunning,
	resetSoftwareUpdateState,
} from "../modules/system/software-updates.ts";
import { addClient, getClients, removeClient } from "../rpc/events.ts";
import { buildInitialStatus } from "../rpc/procedures/status.procedure.ts";
import type { AppWebSocket } from "../rpc/types.ts";

const update = {
	total: 0,
	downloading: 0,
	unpacking: 0,
	setting_up: 0,
};

function socket(received: unknown[]): AppWebSocket {
	return {
		data: { isAuthenticated: true, lastActive: Date.now() },
		send(message: string) {
			received.push(JSON.parse(message));
		},
	} as AppWebSocket;
}

describe("software-update status reaches clients across recovery", () => {
	afterEach(() => {
		for (const client of [...getClients()]) removeClient(client);
		resetSoftwareUpdateState();
	});

	test("a freshly authenticated client receives both fields in the initial status", async () => {
		const recovered = await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return undefined as never;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});
		expect(recovered).toBe(false);

		const status = buildInitialStatus().status;
		expect(status).toHaveProperty("updating");
		expect(status).toHaveProperty("update_state");
		expect(status.updating).not.toBeNull();
	});

	test("a client already authenticated receives the reattach broadcast", async () => {
		const received: unknown[] = [];
		const client = socket(received);
		addClient(client);

		await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached }) => {
				onAttached?.();
				return undefined as never;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});

		const frame = received.find((value) => {
			const status = (value as { status?: Record<string, unknown> }).status;
			return status?.updating !== undefined;
		}) as { status: { updating: unknown; update_state: unknown } };
		expect(frame.status).toHaveProperty("updating");
		expect(frame.status).toHaveProperty("update_state");
		expect(frame.status.updating).toEqual(update);
	});

	test("a client after the terminal frame receives explicit updating null", () => {
		const status = buildInitialStatus().status;
		expect(status).toHaveProperty("updating", null);
		expect(status).toHaveProperty("update_state");
	});
});
