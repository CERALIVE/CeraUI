import { afterEach, describe, expect, test } from "bun:test";
import { statusResponseSchema } from "@ceraui/rpc";

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

	test("publishes a single buffered package's first install progress to both status consumers", async () => {
		const received: unknown[] = [];
		addClient(socket(received));

		await recoverSoftwareUpdateIfRunning({
			recover: async ({ onAttached, onStdout }) => {
				onAttached?.();
				onStdout("Reading package lists...\n");
				expect(buildInitialStatus().status.updating).toEqual(update);

				// No parseable counters until apt releases the buffered transcript.
				onStdout(
					"1 upgraded, 0 newly installed, 0 to remove.\n" +
						"Get:1 https://example.invalid cerastream [48 MB]\n" +
						"Unpacking cerastream (2) over (1) ...\n",
				);
				return null;
			},
			scheduleRetry: () => {},
			resumePeriodicChecks: () => {},
		});

		const installing = { ...update, total: 1, downloading: 1, unpacking: 1 };
		const frames = received.flatMap((frame) => {
			if (typeof frame !== "object" || !frame || !("status" in frame))
				return [];
			const parsed = statusResponseSchema.safeParse(frame.status);
			return parsed.success && parsed.data.updating ? [parsed.data] : [];
		});
		expect(frames).toMatchObject([
			{
				updating: update,
				update_state: { kind: "downloading", progress: update },
			},
			{
				updating: installing,
				update_state: { kind: "installing", progress: installing },
			},
		]);
	});
});
