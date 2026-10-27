import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeKernelState } from "../modules/system/update-orchestrator/kernel-recovery.ts";
import {
	acknowledgeKernelState,
	kernelStateSchema,
	readKernelState,
	readSlotOverlay,
} from "../modules/system/update-orchestrator/kernel-state.ts";
import {
	clearInstalledImageOverlay,
	parseInstalledImage,
	readInstalledImage,
} from "../modules/system/update-orchestrator/os-installed-image.ts";
import {
	loadOrchestratorState,
	saveOrchestratorState,
} from "../modules/system/update-orchestrator/persistence.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";
import fixture from "./fixtures/real-device/rock-admission-20261009.json";
import {
	baseImage,
	kernelOverlay,
	kernelRecord,
	kernelState,
} from "./helpers/kernel-update-fixture.ts";

const stdout =
	fixture.commands["rauc status --detailed --output-format=json"].stdout;
test("kernel outcome verifies package/version AND target, never an unchanged OS version", () => {
	// Given the producer's terminal success and confirmed overlay.
	const record = { ...kernelState, state: "succeeded" as const };
	const overlay = { ...kernelOverlay, status: "confirmed" as const };
	// When the actual boot facts differ in exactly one axis.
	expect(judgeKernelState(record, "B", kernelRecord, overlay)).toEqual({
		phase: "kernel-succeeded",
		reason: null,
	});
	expect(judgeKernelState(record, "A", kernelRecord, overlay).phase).toBe(
		"kernel-verifying",
	);
	expect(
		judgeKernelState(
			record,
			"B",
			{ ...kernelRecord, version: "7.2.0-ceralive1" },
			overlay,
		).phase,
	).toBe("kernel-verifying");
	expect(
		judgeKernelState(
			{ ...record, state: "rolled_back" },
			"A",
			kernelRecord,
			overlay,
		),
	).toEqual({ phase: "kernel-rolled-back", reason: "kernel_boot_failed" });
});
test("kernel success refuses the wrong booted package name independently of version and slot", () => {
	const record = { ...kernelState, state: "succeeded" as const };
	const overlay = { ...kernelOverlay, status: "confirmed" as const };
	expect(
		judgeKernelState(
			record,
			"B",
			{
				package: "linux-image-7.3.0-ceralive-rk3588",
				version: record.version,
			},
			overlay,
		),
	).toEqual({
		phase: "kernel-verifying",
		reason: "kernel_identity_mismatch",
	});
});
test("kernel state accepts retained UTC timestamps keyed by every entered state", () => {
	const timestamps = {
		staging: "2026-09-30T23:00:00Z",
		staged: "2026-10-01T00:00:00Z",
		armed: "2026-10-01T00:01:00Z",
		activating: "2026-10-02T00:00:00Z",
		activated: "2026-10-02T00:00:01Z",
		succeeded: "2026-10-02T00:01:00Z",
		rolled_back: "2026-10-02T00:02:00Z",
		failed: "2026-10-02T00:03:00Z",
	};
	expect(
		kernelStateSchema.parse({ ...kernelState, timestamps }).timestamps,
	).toEqual(timestamps);
});
test.each(["started_at", "updated_at"])(
	"kernel state rejects the non-state timestamp key %s",
	(key) => {
		expect(
			kernelStateSchema.safeParse({
				...kernelState,
				timestamps: {
					...kernelState.timestamps,
					[key]: "2026-10-01T00:00:00Z",
				},
			}).success,
		).toBe(false);
	},
);
test.each([
	"staged",
	"armed",
	"activating",
	"activated",
	"succeeded",
	"rolled_back",
])("kernel state %s requires the retained staged clock", (state) => {
	const result = kernelStateSchema.safeParse({
		...kernelState,
		state,
		timestamps: { staging: "2026-10-01T00:00:00Z" },
	});
	expect(result.success).toBe(false);
});
test.each(["2026-10-01T00:00:00+00:00", "2026-10-01", 1790812800000])(
	"kernel timestamps reject non-UTC-Z values %j",
	(staged) => {
		expect(
			kernelStateSchema.safeParse({
				...kernelState,
				timestamps: { staged },
			}).success,
		).toBe(false);
	},
);
test("both installed-image roles report base identity plus local overlay, never retained bundle alone", () => {
	for (const role of ["booted", "inactive"] as const) {
		const plain = parseInstalledImage(stdout, role);
		if (!plain) throw new Error("fixture identity");
		const image = parseInstalledImage(stdout, role, kernelOverlay);
		expect(image?.identity).toEqual({
			...baseImage,
			slot: plain.identity.slot,
			kernelOverlay: {
				...kernelOverlay.kernel,
				attempt: kernelState.attempt,
				status: "pending",
			},
		});
		expect(
			parseInstalledImage(stdout, role, {
				status: "invalid",
				attempt: kernelState.attempt,
				reason: "kernel_staging",
			}),
		).toBeNull();
	}
});
test("inactive invalid overlay stays unknown across acknowledgement and backend restart until a verified mirror rewrites it", async () => {
	// Given an interrupted target with retained RAUC bundle metadata.
	const directory = await mkdtemp(join(tmpdir(), "kernel-overlay-"));
	const selected = parseInstalledImage(stdout, "inactive");
	const bootname = selected?.bootname;
	if (bootname !== "A" && bootname !== "B") throw new Error("fixture bootname");
	const file = join(directory, `slot-overlay-${bootname}.json`);
	await writeFile(
		join(directory, "kernel-state.json"),
		JSON.stringify({
			...kernelState,
			target_slot: bootname,
			booted_slot_at_stage: bootname === "A" ? "B" : "A",
			state: "failed",
			reason: "interrupted",
		}),
	);
	await writeFile(
		file,
		JSON.stringify({
			status: "invalid",
			attempt: kernelState.attempt,
			reason: "kernel_staging",
		}),
	);
	const run = async () => ({ exitCode: 0, stdout, stderr: "" });
	try {
		expect(await readInstalledImage("inactive", { run, directory })).toBeNull();
		acknowledgeKernelState(kernelState.attempt, directory);
		const child = Bun.spawn(
			[
				process.execPath,
				"-e",
				'const {readInstalledImage}=await import(process.argv[1]);const stdout=await Bun.stdin.text();const identity=await readInstalledImage("inactive",{directory:process.argv[2],run:async()=>({exitCode:0,stdout,stderr:""})});console.log(JSON.stringify(identity));',
				new URL(
					"../modules/system/update-orchestrator/os-installed-image.ts",
					import.meta.url,
				).pathname,
				directory,
			],
			{ stdin: "pipe", stdout: "pipe", stderr: "pipe" },
		);
		child.stdin.write(stdout);
		await child.stdin.end();
		const [restarted, error, exit] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(exit, error).toBe(0);
		expect(JSON.parse(restarted)).toBeNull();
		// Then outcome acknowledgement and a restarted backend both retain invalidation.
		expect((await readKernelState(directory))?.acknowledged).toBe(true);
		expect((await readSlotOverlay(bootname, directory))?.status).toBe(
			"invalid",
		);
		expect(await readInstalledImage("inactive", { run, directory })).toBeNull();
		// Then only a verified mirror fixture replacing the record restores identity.
		await writeFile(
			file,
			JSON.stringify({ ...kernelOverlay, status: "confirmed" }),
		);
		expect(
			(await readInstalledImage("inactive", { run, directory }))?.kernelOverlay
				?.status,
		).toBe("confirmed");
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("staged state without matching overlay refuses activation", () => {
	expect(judgeKernelState(kernelState, "A", kernelRecord, null)).toEqual({
		phase: "kernel-failed",
		reason: "kernel_identity_mismatch",
	});
});
test("successful full RAUC installation clears only the installed target overlay", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-rauc-clear-"));
	const inactive = parseInstalledImage(stdout, "inactive")?.bootname;
	if (inactive !== "A" && inactive !== "B") throw new Error("fixture bootname");
	const booted = inactive === "A" ? "B" : "A";
	await writeFile(
		join(directory, `slot-overlay-${inactive}.json`),
		JSON.stringify({
			status: "invalid",
			attempt: kernelState.attempt,
			reason: "kernel_staging",
		}),
	);
	await writeFile(
		join(directory, `slot-overlay-${booted}.json`),
		JSON.stringify(kernelOverlay),
	);
	const run = async () => ({ exitCode: 0, stdout, stderr: "" });
	try {
		await clearInstalledImageOverlay("inactive", { run, directory });
		expect(await readSlotOverlay(inactive, directory)).toBeNull();
		expect(await readSlotOverlay(booted, directory)).toEqual(kernelOverlay);
		expect(
			(await readInstalledImage("inactive", { run, directory }))?.kernelOverlay,
		).toBeUndefined();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("unproven RAUC target never clears persistent overlay invalidation", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-rauc-unknown-"));
	const invalid = {
		status: "invalid" as const,
		attempt: kernelState.attempt,
		reason: "kernel_staging",
	};
	await writeFile(
		join(directory, "slot-overlay-B.json"),
		JSON.stringify(invalid),
	);
	try {
		await expect(
			clearInstalledImageOverlay("inactive", {
				directory,
				run: async () => ({ exitCode: 1, stdout: "", stderr: "unavailable" }),
			}),
		).rejects.toThrow();
		expect(await readSlotOverlay("B", directory)).toEqual(invalid);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("kernel attempt argv identity survives the actual agent persistence boundary", async () => {
	const directory = await mkdtemp(join(tmpdir(), "kernel-attempt-"));
	const file = join(directory, "agent.json");
	const state = {
		...initialOrchestratorState(1),
		phase: "kernel-staging" as const,
		kernelAttempt: {
			id: kernelState.attempt,
			package: kernelRecord.package,
			version: kernelRecord.version,
			deb_sha256: kernelRecord.deb_sha256,
			deb: "/var/tmp/ceraui-kernel-fixture/kernel.deb",
		},
	};
	try {
		saveOrchestratorState(state, file);
		expect(await loadOrchestratorState(file)).toEqual(state);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
