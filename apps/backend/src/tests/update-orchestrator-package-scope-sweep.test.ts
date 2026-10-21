import { afterEach, expect, test } from "bun:test";
import {
	getOrchestratorState,
	installUpdatesNow,
} from "../modules/system/update-orchestrator/runtime.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { testQuarantine } from "./helpers/orchestrator-runtime-harness.ts";
import { setup as osFixture } from "./helpers/os-agent-runtime-harness.ts";
import {
	cleanScopedFixture,
	movePhase,
	offeredPackages,
} from "./helpers/package-scoped-install.ts";

useSessionOwnerForFile();
afterEach(cleanScopedFixture);

const flips = [
	"os-available",
	"os-staging",
	"committing",
	"failed",
	"stream",
] as const;

function sweepFixture() {
	// Counters deliberately retain effects after the authoritative flip.
	let flipped = false;
	let live = false;
	let launches = 0;
	let launchesAfterFlip = 0;
	let persistsAfterFlip = 0;
	const quarantine = testQuarantine();
	const os = osFixture({
		quarantine,
		isUpdateAdmissionReady: async () => true,
		isStreamLive: () => live,
		getPackageInstallWireState: () => offeredPackages,
		startPackageInstall: () => {
			launches++;
			if (flipped) launchesAfterFlip++;
			return { started: true };
		},
		persist: () => {
			if (flipped) persistsAfterFlip++;
		},
	});
	movePhase("available");
	return {
		quarantine,
		stages: os.stages,
		launches: () => launches,
		launchesAfterFlip: () => launchesAfterFlip,
		persistsAfterFlip: () => persistsAfterFlip,
		flip(target: (typeof flips)[number]) {
			if (target === "stream") live = true;
			else movePhase(target);
			flipped = true;
			return getOrchestratorState();
		},
	};
}

// Macrotasks allow the real quarantine I/O to complete. Microtasks also reach
// bare recovery-helper awaits, which dependency-port fault injection misses.
async function flipAfter(
	macro: number,
	micro: number,
	act: () => void,
): Promise<void> {
	for (let i = 0; i < macro; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
	let chain = Promise.resolve();
	for (let i = 0; i < micro; i++) chain = chain.then(() => undefined);
	await chain;
	act();
}

for (const scoped of [true, false]) {
	test(`${scoped ? "scoped install stays fenced" : "unscoped control can stage OS"} when phase or stream flips across macro/micro awaits`, async () => {
		const violations: string[] = [];
		let flippedCases = 0;
		let stagedCases = 0;
		for (const target of flips) {
			for (let macro = 0; macro <= 40; macro++) {
				let anyBefore = false;
				for (let micro = 0; micro <= 40; micro++) {
					// Given fresh package authority and the real OS-dispatch fixture.
					const f = sweepFixture();
					let done = false;
					let stateAtFlip: ReturnType<typeof getOrchestratorState> | undefined;
					// When authority flips during the manual call at this turn offset.
					const call = installUpdatesNow(
						scoped ? { scope: "packages" } : undefined,
					).then((outcome) => {
						done = true;
						return outcome;
					});
					const flipper = flipAfter(macro, micro, () => {
						if (!done) stateAtFlip = f.flip(target);
					});
					const outcome = await call;
					await flipper;
					// Join queued continuation turns before inspecting or resetting globals.
					for (let i = 0; i < 5; i++)
						await new Promise<void>((resolve) => setImmediate(resolve));
					// Then a scoped call cannot acquire effects or replace newer authority.
					if (stateAtFlip) {
						anyBefore = true;
						flippedCases++;
						if (f.stages()) stagedCases++;
						if (scoped) {
							const tag = `${target} macro=${macro} micro=${micro}`;
							if (f.stages()) violations.push(`${tag}: OS staged`);
							if (f.launchesAfterFlip())
								violations.push(`${tag}: package launched`);
							if (f.persistsAfterFlip())
								violations.push(`${tag}: state persisted`);
							if (getOrchestratorState() !== stateAtFlip)
								violations.push(`${tag}: state replaced`);
							const plan = await f.quarantine.readPending();
							if (!outcome.started && plan.length)
								violations.push(`${tag}: plan retained`);
							if (outcome.started && f.launches() !== 1)
								violations.push(`${tag}: started without package launch`);
						}
					}
					cleanScopedFixture();
				}
				if (!anyBefore) break;
			}
		}
		console.info({ scoped, flippedCases, stagedCases });
		expect(flippedCases).toBeGreaterThan(0);
		if (scoped) expect(violations).toEqual([]);
		else expect(stagedCases).toBeGreaterThan(0);
	}, 240_000);
}

test.each([undefined, {}])(
	"unscoped OS install is preserved when input is %j",
	async (input) => {
		// Given a real OS offer and a runtime input accepted by the RPC schema.
		const f = osFixture({ isUpdateAdmissionReady: async () => true });
		// When either no input or an empty object is passed.
		const outcome = await installUpdatesNow(input);
		// Then both take the original OS route rather than a package refusal.
		expect(outcome).toEqual({ started: true });
		expect(f.stages()).toBe(1);
		expect(getOrchestratorState().phase).toBe("os-staged");
	},
);
