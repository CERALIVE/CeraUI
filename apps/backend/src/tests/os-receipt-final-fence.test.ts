import { expect, test } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readStagedReceiptEvidence } from "../modules/system/update-orchestrator/os-agent.ts";
import {
	retireConsumedStagedReceipt,
	retireStagedReceipt,
} from "../modules/system/update-orchestrator/os-staged-receipt-retirement.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import { acquireTestOsStageControl } from "./helpers/os-stage-test-control.ts";

const bootId = "29dd9a67-91db-412a-8729-accdb5825369";
const image = {
	slot: "rootfs.0",
	bundleHash: "a".repeat(64),
	checksum: "b".repeat(64),
	installedAt: "2026-10-08T12:54:01Z",
	installedCount: 7,
};
const receipt = {
	schema: 1 as const,
	version: "2026.10.64",
	channel: "drill" as const,
	stagedAt: 1791464043236,
	bootId: "070fd8ac-4a40-4b85-9d31-f21502ebd117",
	installedImage: image,
};
const state = { ...initialOrchestratorState(0), phase: "failed" as const };

test.each(["identical replacement", "late activation"] as const)(
	"keeps evidence after %s during final authority read",
	async (race) => {
		// Given real receipt and marker paths, with a barrier at the last awaited authority read.
		const dir = mkdtempSync("/var/tmp/ceraui-receipt-final-");
		const live = join(dir, "os-staged.json");
		const marker = join(dir, "activation-armed");
		const bytes = JSON.stringify(receipt);
		writeFileSync(live, bytes);
		const original = statSync(live).ino;
		let reads = 0;
		// When the controller reaches the last authority reread.
		const result = await retireConsumedStagedReceipt({
			snapshot: () => ({
				state,
				phase: state.phase,
				activeAttemptId: null,
				generation: 1,
				producing: false,
			}),
			acquireControl: acquireTestOsStageControl,
			readPersisted: async () => {
				if (++reads === 2) {
					if (race === "identical replacement") {
						writeFileSync(join(dir, "replacement"), bytes);
						renameSync(join(dir, "replacement"), live);
					} else writeFileSync(marker, "armed");
				}
				return state;
			},
			readReceipt: () => readStagedReceiptEvidence(dir),
			readBootedVersion: async () => receipt.version,
			readBootId: async () => bootId,
			readHealthyBootId: async () => bootId,
			readBootedImage: async () => image,
			readActivationArmed: async () => existsSync(marker),
			inspectOperation: async () => "idle",
			retire: (judged) => retireStagedReceipt(judged, dir),
		});
		// Then neither a replacement inode nor late activation is consumed.
		expect(result).toBe(false);
		expect(readFileSync(live, "utf8")).toBe(bytes);
		if (race === "identical replacement")
			expect(statSync(live).ino).not.toBe(original);
		else expect(existsSync(marker)).toBe(true);
	},
);
