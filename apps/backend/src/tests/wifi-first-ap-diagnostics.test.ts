import { afterEach, expect, mock, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { runFirstAp } from "../../test-harness/wifi-hwsim/checks/first-ap-diagnostics.ts";

afterEach(() => mock.restore());

const secret = "test-only-forbidden-psk-42";

test("a completed native scenario succeeds without a failure receipt", async () => {
	const errors = spyOn(console, "error").mockImplementation(() => {});
	const phases = spyOn(console, "log").mockImplementation(() => {});

	const success = await runFirstAp(async (checkpoint) => {
		checkpoint("a.inactive");
	});

	expect(success).toBe(true);
	expect(errors).not.toHaveBeenCalled();
	expect(phases).toHaveBeenCalledWith("first-ap: phase", "a.inactive");
});

test("native command failures retain their phase without logging credentials or argv", async () => {
	const errors: unknown[][] = [];
	const phases: unknown[][] = [];
	spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args);
	});
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		phases.push(args);
	});
	const failure = Object.assign(new Error(`nmcli failed with ${secret}`), {
		cmd: ["nmcli", "connection", "add", "psk", secret],
		stdout: secret,
		stderr: secret,
	});

	const success = await runFirstAp(async (checkpoint) => {
		checkpoint("a.add");
		throw failure;
	});

	expect(success).toBe(false);
	expect(JSON.stringify([...phases, ...errors])).not.toContain(secret);
	expect(errors).toEqual([
		[
			"first-ap: FAIL",
			{ phase: "a.add", check: "profile-create", kind: "command-or-runtime" },
		],
	]);
	expect(phases).toEqual([["first-ap: phase", "a.add"]]);
});

test("native assertion diagnostics report fixed check identity and shapes without values", async () => {
	const errors: unknown[][] = [];
	spyOn(console, "error").mockImplementation((...args: unknown[]) => {
		errors.push(args);
	});
	spyOn(console, "log").mockImplementation(() => {});

	const success = await runFirstAp(async (checkpoint) => {
		checkpoint("a.binding");
		assert.deepEqual([secret, "ap"], [null], secret);
	});

	expect(success).toBe(false);
	expect(JSON.stringify(errors)).not.toContain(secret);
	expect(errors).toEqual([
		[
			"first-ap: FAIL",
			{
				phase: "a.binding",
				check: "profile-binding-fields",
				kind: "assertion",
				actual: { kind: "array", length: 2 },
				expected: { kind: "array", length: 1 },
			},
		],
	]);
});

for (const [phase, check, error] of [
	["saved.confirm", "initial-backend-confirmation", "activation-failed"],
	["saved.stop", "backend-stop", "no-device"],
	["saved.restart", "saved-backend-confirmation", "not-confirmed"],
] as const) {
	test(`native ${phase} receipts retain only the whitelisted error category`, async () => {
		const receipts: unknown[][] = [];
		spyOn(console, "log").mockImplementation((...args: unknown[]) => {
			receipts.push(args);
		});

		await runFirstAp(async (checkpoint) => {
			checkpoint(phase, {
				success: false,
				error,
				reason: secret,
				cmd: ["nmcli", "psk", secret],
			});
		});

		expect(receipts).toContainEqual([
			"first-ap: outcome",
			{ phase, check, success: false, error },
		]);
		expect(JSON.stringify(receipts)).not.toContain(secret);
	});
}

test("native outcome receipts discard a non-enum error without logging it", async () => {
	const receipts: unknown[][] = [];
	spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		receipts.push(args);
	});

	await runFirstAp(async (checkpoint) => {
		checkpoint("saved.stop", { success: false, error: secret, reason: secret });
	});

	expect(receipts).toContainEqual([
		"first-ap: outcome",
		{ phase: "saved.stop", check: "backend-stop", success: false },
	]);
	expect(JSON.stringify(receipts)).not.toContain(secret);
});
