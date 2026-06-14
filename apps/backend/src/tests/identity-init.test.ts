import { beforeEach, describe, expect, test } from "bun:test";

import type { RuntimeConfig } from "../helpers/config-schemas.ts";
import {
	canDialControlChannel,
	getIdentity,
	type IdentityLogger,
	initIdentity,
	UNPAIRED_IDENTITY,
} from "../modules/identity/index.ts";

const DEVICE_ID = "7a03d468-3c9e-4b7a-8483-1f2a3b4c5d6e";
const REMOTE_KEY = "v4.public.stub-token-payload";

const silent: IdentityLogger = {
	info: () => {},
	warn: () => {},
};

function readConfig(
	partial: Partial<RuntimeConfig>,
): () => Pick<RuntimeConfig, "device_id" | "remote_key"> {
	return () => partial;
}

// Module identity is process-wide; reset to the unpaired floor before each case
// so a paired result never leaks into an unpaired assertion.
beforeEach(async () => {
	await initIdentity({ readConfig: readConfig({}), logger: silent });
});

describe("initIdentity when the device is paired", () => {
	test("resolves device_id and reports paired", async () => {
		const identity = await initIdentity({
			readConfig: readConfig({ remote_key: REMOTE_KEY, device_id: DEVICE_ID }),
			logger: silent,
		});

		expect(identity).toEqual({ paired: true, deviceId: DEVICE_ID });
		expect(getIdentity()).toEqual({ paired: true, deviceId: DEVICE_ID });
	});

	test("opens the control-channel gate", async () => {
		await initIdentity({
			readConfig: readConfig({ remote_key: REMOTE_KEY, device_id: DEVICE_ID }),
			logger: silent,
		});

		expect(canDialControlChannel()).toBe(true);
	});

	test("keeps the gate closed when paired but device_id is missing", async () => {
		const identity = await initIdentity({
			readConfig: readConfig({ remote_key: REMOTE_KEY }),
			logger: silent,
		});

		expect(identity).toEqual({ paired: true, deviceId: undefined });
		expect(canDialControlChannel()).toBe(false);
	});
});

describe("initIdentity when the device has never been paired", () => {
	test("resolves to the unpaired floor without throwing", async () => {
		const identity = await initIdentity({
			readConfig: readConfig({ device_id: DEVICE_ID }),
			logger: silent,
		});

		expect(identity).toEqual({ paired: false, deviceId: undefined });
		expect(getIdentity()).toEqual(UNPAIRED_IDENTITY);
	});

	test("leaves the control-channel gate flag false", async () => {
		await initIdentity({ readConfig: readConfig({}), logger: silent });

		expect(getIdentity().paired).toBe(false);
		expect(canDialControlChannel()).toBe(false);
	});

	test("falls back to unpaired when the config read throws (fail-soft)", async () => {
		const throwingRead = () => {
			throw new Error("config unreadable");
		};

		const identity = await initIdentity({
			readConfig: throwingRead,
			logger: silent,
		});

		expect(identity).toEqual(UNPAIRED_IDENTITY);
		expect(canDialControlChannel()).toBe(false);
	});
});
