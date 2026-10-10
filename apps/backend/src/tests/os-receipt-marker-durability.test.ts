import { afterEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	retireConsumedStagedReceipt,
	retireStagedReceipt,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import { defaultOrchestratorRuntimeDeps } from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const dirs: string[] = [];
const receipt = {
	schema: 1 as const,
	version: "2026.10.64",
	channel: "drill" as const,
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
};
function directory() {
	const dir = mkdtempSync("/var/tmp/ceraui-receipt-durability-");
	dirs.push(dir);
	return dir;
}
afterEach(() => {
	for (const dir of dirs.splice(0)) {
		chmodSync(dir, 0o700);
		rmSync(dir, { recursive: true, force: true });
	}
});

test("preserves unknown activation evidence when lstat returns real EACCES", async () => {
	// Given a real permission-denied path, not an absent marker.
	const dir = directory();
	writeFileSync(join(dir, "activation-armed"), "armed");
	chmodSync(dir, 0);
	// When production's marker reader probes that path.
	const result = Reflect.apply(
		defaultOrchestratorRuntimeDeps.readActivationArmed,
		undefined,
		[join(dir, "activation-armed")],
	);
	// Then it rejects rather than supplying false absence to retirement.
	await expect(result).rejects.toMatchObject({ code: "EACCES" });
});

test("counts a dangling activation symlink as present", async () => {
	// Given a marker inode whose target is missing.
	const dir = directory();
	symlinkSync(join(dir, "missing"), join(dir, "activation-armed"));
	// When production's marker reader probes the inode.
	const result = await Reflect.apply(
		defaultOrchestratorRuntimeDeps.readActivationArmed,
		undefined,
		[join(dir, "activation-armed")],
	);
	// Then no missing target can authorize receipt retirement.
	expect(result).toBe(true);
});

test("retries directory acknowledgement after a completed rename and failed fsync", () => {
	// Given real receipt bytes and a directory-fsync fault at the narrow seam.
	const dir = directory();
	const bytes = JSON.stringify(receipt);
	writeFileSync(join(dir, "os-staged.json"), bytes);
	let syncs = 0;
	const sync = () => {
		syncs++;
		if (syncs === 1)
			throw Object.assign(new Error("fsync fault"), { code: "EIO" });
	};
	// When rename completes but acknowledgement fails, then the same operation retries.
	expect(() =>
		Reflect.apply(retireStagedReceipt, undefined, [receipt, dir, sync]),
	).toThrow();
	expect(existsSync(join(dir, "os-staged.json"))).toBe(false);
	expect(readFileSync(join(dir, "os-staged.consumed.json"), "utf8")).toBe(
		bytes,
	);
	expect(
		Reflect.apply(retireStagedReceipt, undefined, [receipt, dir, sync]),
	).toBe(false);
	// Then the missing live name does not suppress the durability retry.
	expect(syncs).toBe(2);
});

test("the controller retries acknowledgement with no live receipt without reading image evidence", async () => {
	// Given rename completed and only the consumed inode remains.
	const dir = directory();
	writeFileSync(join(dir, "os-staged.consumed.json"), JSON.stringify(receipt));
	const state = initialOrchestratorState(0);
	let acknowledgements = 0;
	const unreachable = async (): Promise<never> => {
		throw new Error("image evidence must not be read for acknowledgement");
	};
	// When the production controller reaches its absent-live replay path under CONTROL.
	const result = await retireConsumedStagedReceipt({
		snapshot: () => ({
			state,
			phase: state.phase,
			activeAttemptId: null,
			generation: 0,
			producing: false,
		}),
		readReceipt: async () => undefined,
		acknowledgementPending: () =>
			existsSync(join(dir, "os-staged.consumed.json")),
		acknowledge: () => {
			acknowledgements++;
		},
		acquireControl: acquireTestOsStageControl,
		readPersisted: async () => state,
		readBootedVersion: unreachable,
		readBootId: unreachable,
		readHealthyBootId: unreachable,
		readBootedImage: unreachable,
		readActivationArmed: unreachable,
		inspectOperation: unreachable,
		retire: () => {
			throw new Error("must not rename again");
		},
	});
	// Then durability is retried without a second rename or image judgement.
	expect(result).toBe(false);
	expect(acknowledgements).toBe(1);
});
