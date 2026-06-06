import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { getSystemdSocket } from "../modules/system/systemd.ts";

describe("systemd socket activation (getSystemdSocket)", () => {
	let originalListenFds: string | undefined;

	beforeEach(() => {
		originalListenFds = process.env.LISTEN_FDS;
	});

	afterEach(() => {
		if (originalListenFds === undefined) {
			delete process.env.LISTEN_FDS;
		} else {
			process.env.LISTEN_FDS = originalListenFds;
		}
	});

	test("returns the first systemd fd (3) when LISTEN_FDS=1", () => {
		process.env.LISTEN_FDS = "1";
		const result = getSystemdSocket();
		expect(result).not.toBeUndefined();
		expect(result?.fd).toBe(3);
	});

	test("returns undefined when LISTEN_FDS is unset", () => {
		delete process.env.LISTEN_FDS;
		expect(getSystemdSocket()).toBeUndefined();
	});

	test("returns undefined when LISTEN_FDS is not exactly '1'", () => {
		process.env.LISTEN_FDS = "0";
		expect(getSystemdSocket()).toBeUndefined();

		process.env.LISTEN_FDS = "2";
		expect(getSystemdSocket()).toBeUndefined();

		process.env.LISTEN_FDS = "";
		expect(getSystemdSocket()).toBeUndefined();
	});
});
