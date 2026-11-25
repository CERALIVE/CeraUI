import { expect, spyOn, test } from "bun:test";
import * as activation from "../modules/modems/modem-ready-activation.ts";
import {
	runModemStatusPoll,
	setModemPresenceDepsForTest,
} from "../modules/modems/modem-update-loop.ts";
import * as radio from "../modules/modems/radio-health-runtime.ts";
import { withModemUpdateLock } from "../modules/network/state/device-lock.ts";

test("a slow diagnostic refresh leaves the modem update lock available", async () => {
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const paused = new Promise<void>((resolve) => {
		release = resolve;
	});
	const refresh = spyOn(radio, "refreshRadioHealth").mockImplementation(
		async () => {
			entered();
			await paused;
		},
	);
	setModemPresenceDepsForTest({
		listModems: async () => [],
		registerModem: async () => {},
		refreshStatus: async () => {},
		refreshIdPaths: async () => {},
	});
	const ready = spyOn(activation, "runModemReadyActivations").mockResolvedValue(
		[],
	);
	const poll = runModemStatusPoll();
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await started;
		expect(ready).toHaveBeenCalledTimes(1);
		const acquired = await Promise.race([
			withModemUpdateLock(async () => {}).then(() => true),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), 100);
			}),
		]);
		expect(acquired).toBe(true);
	} finally {
		if (timer) clearTimeout(timer);
		release();
		await poll;
		refresh.mockRestore();
		ready.mockRestore();
		setModemPresenceDepsForTest(null);
	}
}, 2000);
