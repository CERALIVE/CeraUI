import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UpdateQuarantine } from "../modules/system/update-orchestrator/quarantine.ts";
import {
	checkUpdatesNow,
	installUpdatesNow,
	resetOrchestratorRuntimeForTest,
	setOrchestratorRuntimeDepsForTest,
	setOrchestratorStateForTest,
} from "../modules/system/update-orchestrator/runtime.ts";
import { initialOrchestratorState } from "../modules/system/update-orchestrator/types.ts";

const directory = mkdtempSync(join(tmpdir(), "ceraui-admission-order-"));
afterEach(() => resetOrchestratorRuntimeForTest());

for (const action of [installUpdatesNow, checkUpdatesNow]) {
	test(`${action.name} preserves caller order when independent admission probes resolve in reverse`, async () => {
		// Given a first probe slower than the second and real pending-plan persistence.
		const first = Promise.withResolvers<boolean>();
		const second = Promise.withResolvers<boolean>();
		const checked = Promise.withResolvers<void>();
		let probes = 0;
		let installs = 0;
		setOrchestratorRuntimeDepsForTest({
			isUpdateAdmissionReady: () =>
				++probes === 1 ? first.promise : second.promise,
			isStreamLive: () => false,
			loadCapabilities: async () => ({ mode: "legacy", features: [] }),
			persist: () => {},
			publishWireState: () => {},
			quarantine: new UpdateQuarantine(join(directory, `${action.name}.json`)),
			runPackageCheck: async () => {
				await checked.promise;
				return null;
			},
			getPackageInstallWireState: () => ({
				kind: "available",
				identity: { version: "2026.10.0", packages: ["cerastream"] },
				package_count: 1,
				actionable_count: 1,
				packages: [
					{
						name: "cerastream",
						version: "2026.10.0",
						layer: "app",
						actionable: true,
					},
				],
			}),
			startPackageInstall: () => {
				installs++;
				return { started: true };
			},
		});
		setOrchestratorStateForTest({
			...initialOrchestratorState(0),
			phase: "available",
		});
		// When the two requests arrive in order, but the second probe answers first.
		const outcomes = Promise.all([action(), action()]);
		second.resolve(true);
		await second.promise;
		first.resolve(true);
		checked.resolve();
		// Then only the original caller owns the operation, independent of I/O completion order.
		expect(await outcomes).toEqual([
			{ started: true },
			{ started: false, reason: "busy" },
		]);
		if (action === installUpdatesNow) expect(installs).toBe(1);
	});
}

test("manual admission re-probes after the preceding request settles", async () => {
	// Given readiness changes between requests, with no cached positive permission.
	let probes = 0;
	setOrchestratorRuntimeDepsForTest({
		isUpdateAdmissionReady: async () => ++probes === 1,
		loadCapabilities: async () => ({ mode: "legacy", features: [] }),
		runPackageCheck: async () => null,
		getPackageInstallWireState: () => ({ kind: "idle" }),
		persist: () => {},
		publishWireState: () => {},
	});
	await checkUpdatesNow();
	// When the next manual check arrives after settlement.
	const outcome = await checkUpdatesNow();
	// Then the newly closed ownership gate refuses it.
	expect(outcome).toEqual({ started: false, reason: "busy" });
	expect(probes).toBe(2);
});

test("manual admission releases a rejected shared probe for the next request", async () => {
	// Given an unreadable probe followed by a positively closed gate.
	const failure = new Error("injected admission read failure");
	setOrchestratorRuntimeDepsForTest({
		isUpdateAdmissionReady: () => Promise.reject(failure),
	});
	await expect(checkUpdatesNow()).rejects.toBe(failure);
	setOrchestratorRuntimeDepsForTest({
		isUpdateAdmissionReady: async () => false,
	});
	// When another request arrives after the rejected read settles.
	const outcome = await checkUpdatesNow();
	// Then the new probe, rather than a stranded rejected promise, decides admission.
	expect(outcome).toEqual({ started: false, reason: "busy" });
});

afterAll(() => rmSync(directory, { recursive: true }));
