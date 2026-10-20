import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AddonState } from "@ceraui/rpc/schemas";
import { SpawnTimeoutError } from "../helpers/bounded-spawn.ts";
import { execFileP } from "../helpers/exec.ts";
import {
	ALLOWED,
	RunAbortError,
	RunTimeoutError,
	run,
} from "../helpers/run.ts";
import { MockAddonDescriptor } from "../mocks/providers/addons.ts";
import {
	ADDON_VALIDATION_FAILED_ERROR,
	enableAddon,
	resolveActiveAddonManagerDeps,
} from "../modules/addons/manager.ts";
import {
	COMMAND_BUDGET,
	settled,
	terminationChild,
} from "./helpers/termination-child.ts";

beforeAll(() => ALLOWED.add(process.execPath));
afterAll(() => ALLOWED.delete(process.execPath));

describe("termination is never command success", () => {
	for (const runner of ["execFileP", "run"] as const) {
		for (const reason of ["timeout", "abort"] as const) {
			test(`${runner} rejects TERM exit zero after our ${reason} with partial output`, async () => {
				// GIVEN a ready real child whose TERM handler exits zero.
				await using child = await terminationChild();
				const abort = new AbortController();
				const options = { timeout: COMMAND_BUDGET, signal: abort.signal };
				const outcome = settled(
					runner === "run"
						? run(process.execPath, child.args, options)
						: execFileP(process.execPath, child.args, options),
				);
				await child.ready;
				// WHEN our deadline/caller cancellation terminates it.
				if (reason === "timeout") child.deadline();
				else abort.abort();
				const result = await outcome;
				// THEN retirement is failure, not its zero-exit success.
				expect(result.kind).toBe("failure");
				if (result.kind !== "failure")
					throw new Error("terminated child succeeded");
				if (runner === "run") {
					expect(result.error).toBeInstanceOf(
						reason === "timeout" ? RunTimeoutError : RunAbortError,
					);
					expect(result.error).toMatchObject({
						partialStdout: "READYTERM_EXIT_ZERO",
						partialStderr: "DIAGNOSTIC",
					});
				} else {
					expect(result.error).toBeInstanceOf(Error);
					expect(result.error).toMatchObject({
						stdout: "READYTERM_EXIT_ZERO",
						stderr: "DIAGNOSTIC",
					});
				}
			}, 30_000);
		}
		test(`${runner} preserves a natural zero before deadline`, async () => {
			// GIVEN a naturally successful child, WHEN collected, THEN retain success.
			const args = ["-e", "process.stdout.write('NATURAL')"];
			const value =
				runner === "run"
					? await run(process.execPath, args, { timeout: 20_000 })
					: (await execFileP(process.execPath, args, { timeout: 20_000 }))
							.stdout;
			expect(value).toBe("NATURAL");
		}, 30_000);
		test(`${runner} preserves a natural nonzero code`, async () => {
			// GIVEN a failed child, WHEN collected, THEN preserve its exit code.
			const args = ["-e", "process.exit(7)"];
			const result = await settled(
				runner === "run"
					? run(process.execPath, args)
					: execFileP(process.execPath, args),
			);
			expect(result).toMatchObject({ kind: "failure", error: { code: 7 } });
		}, 30_000);
	}

	test("runValidateCmd rejects validation after timeout-induced TERM exit zero", async () => {
		// GIVEN the actual default validator and a TERM-zero child.
		await using child = await terminationChild();
		const validate = resolveActiveAddonManagerDeps().runValidate;
		const outcome = settled(validate(child.command, COMMAND_BUDGET));
		await child.ready;
		// WHEN the registered validation deadline fires.
		child.deadline();
		const result = await outcome;
		// THEN it cannot grant healthy admission (false or typed failure).
		expect(result.kind === "failure" || result.value === false).toBe(true);
	}, 30_000);

	test("runValidateCmd retains natural success and nonzero failure", async () => {
		const validate = resolveActiveAddonManagerDeps().runValidate;
		expect(await validate("exit 0", COMMAND_BUDGET)).toBe(true);
		expect(await validate("exit 7", COMMAND_BUDGET)).toBe(false);
	}, 30_000);

	test("typed validation timeout auto-disables with the existing failure reason", async () => {
		// GIVEN completed enable steps and a typed validation timeout.
		const states = new Map<string, AddonState>();
		const masks: string[][] = [];
		const descriptor = {
			...MockAddonDescriptor,
			id: "termination-proof",
			units: { start: ["termination-proof.service"] },
		};
		const deps = {
			...resolveActiveAddonManagerDeps(),
			isRealDevice: async () => true,
			getEffectiveHardware: () => "rk3588" as const,
			getDataFreeBytes: async () => 100 * 1024 ** 3,
			getOsVersion: async () => "13",
			download: async () => undefined,
			verify: async () => undefined,
			stage: async () => undefined,
			helperEnable: async () => undefined,
			runValidate: async () => {
				throw new SpawnTimeoutError("fixture");
			},
			systemctl: async (args: string[]) => {
				masks.push(args);
				return { stdout: "", stderr: "" };
			},
			getState: (id: string) => states.get(id),
			setState: (id: string, state: AddonState) => {
				states.set(id, state);
			},
			broadcast: () => undefined,
			removeArtifact: async () => undefined,
		};
		// WHEN the manager attempts validation.
		const result = await enableAddon(descriptor, deps);
		// THEN the add-on is masked/auto-disabled with typed failure, never enabled.
		expect(result).toEqual({
			success: false,
			error: ADDON_VALIDATION_FAILED_ERROR,
		});
		expect(states.get(descriptor.id)).toMatchObject({
			autoDisabled: true,
			enabled: false,
			lastError: ADDON_VALIDATION_FAILED_ERROR,
		});
		expect(masks).toEqual([
			["start", "termination-proof.service"],
			["mask", "termination-proof.service"],
		]);
	});

	test("execFileP preserves the per-stream maxBuffer ceiling", async () => {
		// GIVEN overflowing output, WHEN collected, THEN retain overflow failure.
		await expect(
			execFileP(process.execPath, ["-e", "process.stdout.write('OVERFLOW')"], {
				maxBuffer: 1,
			}),
		).rejects.toThrow("maxBuffer length exceeded");
	}, 30_000);
});
