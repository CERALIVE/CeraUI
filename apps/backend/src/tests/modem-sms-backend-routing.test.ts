import { afterEach, describe, expect, test } from "bun:test";

import {
	initCellularStack,
	resetCellularStack,
	stopCellularStack,
} from "../modules/cellular/cellular-stack.ts";
import { getConfig } from "../modules/config.ts";
import { readSmsInboxForBackend } from "../modules/modems/sms-backend.ts";

afterEach(async () => {
	await stopCellularStack();
	resetCellularStack();
	delete getConfig().modem_backend;
});

describe("modem_backend routes only the SMS transport", () => {
	for (const backend of ["mmcli", "dbus"] as const) {
		test(`${backend} selects its reader and leaves the other untouched`, async () => {
			getConfig().modem_backend = backend;
			await initCellularStack(
				backend === "dbus"
					? {
							createDbusBackend: () => ({
								start: async () => ({ ok: true }),
								stop: async () => {},
							}),
						}
					: {},
			);
			const calls: string[] = [];

			const result = await readSmsInboxForBackend("2", {
				readMmcli: async () => {
					calls.push("mmcli");
					return { ok: true, messages: [] };
				},
				readDbus: async () => {
					calls.push("dbus");
					return { ok: true, messages: [] };
				},
			});

			expect(result).toEqual({ ok: true, messages: [] });
			expect(calls).toEqual([backend]);
		});
	}
});
