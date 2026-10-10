import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import {
	acknowledgeRetiredReceipt,
	retiredReceiptPresent,
} from "../modules/system/update-orchestrator/os-receipt-retirement-store.ts";
import {
	type ReceiptRetirementPort,
	retireConsumedStagedReceipt,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

test("unchanged acknowledged tombstone avoids CONTROL and native fsync on subsequent passes", async () => {
	// Given a real tombstone and the production store behind the controller ports.
	const dir = fs.mkdtempSync("/var/tmp/ceraui-ack-cache-");
	const path = join(dir, "os-staged.consumed.json");
	fs.writeFileSync(path, "{}");
	const state = initialOrchestratorState(0);
	let acquisitions = 0;
	let syncs = 0;
	const nativeSync = fs.fsyncSync;
	const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		syncs++;
		nativeSync(fd);
	});
	const unreachable = async (): Promise<never> => {
		throw new Error("no live receipt");
	};
	const port: ReceiptRetirementPort = {
		snapshot: () => ({
			state,
			phase: state.phase,
			activeAttemptId: null,
			generation: 0,
			producing: false,
		}),
		readReceipt: async () => undefined,
		acknowledgementPending: () => retiredReceiptPresent(dir),
		acknowledge: () => acknowledgeRetiredReceipt(dir),
		acquireControl: async () => {
			acquisitions++;
			return acquireTestOsStageControl();
		},
		readPersisted: async () => state,
		readBootedVersion: unreachable,
		readBootId: unreachable,
		readHealthyBootId: unreachable,
		readBootedImage: unreachable,
		readActivationArmed: unreachable,
		inspectOperation: unreachable,
		retire: () => {
			throw new Error("must not rename");
		},
	};
	try {
		// When 100 ticks see the same successfully acknowledged identity.
		for (let i = 0; i < 100; i++) await retireConsumedStagedReceipt(port);
		// Then only the first pass enters CONTROL and performs the native directory fsync.
		expect({ acquisitions, syncs }).toEqual({ acquisitions: 1, syncs: 1 });
	} finally {
		sync.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("failed native acknowledgement remains pending until a successful retry", () => {
	// Given a real tombstone and EIO at the native directory syscall.
	const dir = fs.mkdtempSync("/var/tmp/ceraui-ack-failure-");
	fs.writeFileSync(join(dir, "os-staged.consumed.json"), "{}");
	const nativeSync = fs.fsyncSync;
	let syncs = 0;
	const sync = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
		syncs++;
		if (syncs === 1)
			throw Object.assign(new Error("fsync EIO"), { code: "EIO" });
		nativeSync(fd);
	});
	try {
		// When acknowledgement fails and then retries successfully.
		expect(() => acknowledgeRetiredReceipt(dir)).toThrow();
		expect(retiredReceiptPresent(dir)).toBe(true);
		acknowledgeRetiredReceipt(dir);
		// Then the successful identity is no longer pending.
		expect(retiredReceiptPresent(dir)).toBe(false);
		expect(syncs).toBe(2);
	} finally {
		sync.mockRestore();
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("identical-byte replacement and changed bytes require a fresh acknowledgement", () => {
	// Given an acknowledged real inode.
	const dir = fs.mkdtempSync("/var/tmp/ceraui-ack-identity-");
	const path = join(dir, "os-staged.consumed.json");
	fs.writeFileSync(path, "{}");
	acknowledgeRetiredReceipt(dir);
	try {
		// When another inode replaces it, even with identical bytes.
		fs.writeFileSync(join(dir, "replacement"), "{}");
		fs.renameSync(join(dir, "replacement"), path);
		// Then identity drift reopens acknowledgement; content drift does too.
		expect(retiredReceiptPresent(dir)).toBe(true);
		acknowledgeRetiredReceipt(dir);
		fs.writeFileSync(path, '{"changed":true}');
		expect(retiredReceiptPresent(dir)).toBe(true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a new process generation acknowledges an unchanged tombstone again", async () => {
	// Given a tombstone already acknowledged in this process.
	const dir = fs.mkdtempSync("/var/tmp/ceraui-ack-restart-");
	fs.writeFileSync(join(dir, "os-staged.consumed.json"), "{}");
	acknowledgeRetiredReceipt(dir);
	const store = new URL(
		"../modules/system/update-orchestrator/os-receipt-retirement-store.ts",
		import.meta.url,
	).pathname;
	const script = `import { spyOn } from "bun:test"; import * as fs from "node:fs";
const { acknowledgeRetiredReceipt, retiredReceiptPresent } = await import(${JSON.stringify(store)});
const dir = ${JSON.stringify(dir)}; const native = fs.fsyncSync; let syncs = 0;
spyOn(fs, "fsyncSync").mockImplementation(fd => { syncs++; native(fd); });
const pending = retiredReceiptPresent(dir); acknowledgeRetiredReceipt(dir);
process.stdout.write(JSON.stringify({ pending, syncs, after: retiredReceiptPresent(dir) }));`;
	try {
		// When a fresh process reads and acknowledges the same inode.
		const child = Bun.spawn([process.execPath, "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, rc] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		// Then it performs its own native acknowledgement, not inherited cached proof.
		expect(rc, stderr).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			pending: true,
			syncs: 1,
			after: false,
		});
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
