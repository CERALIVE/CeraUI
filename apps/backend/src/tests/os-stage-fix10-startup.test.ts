import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { settleOsStageOrphan } from "../modules/system/update-orchestrator/os-stage-orphan.ts";
import { acquireOsOrphanLock } from "../modules/system/update-orchestrator/os-stage-orphan-lock.ts";
import {
	osUpdateAdmissionReady,
	reconcileOsStageStartup,
} from "../modules/system/update-orchestrator/os-stage-startup.ts";
import { sweepUpdateRules } from "../modules/system/update-transport/pin-rules.ts";
import { rockHelperFixture } from "./helpers/os-stage-rock-helper-fixture.ts";

async function quietStartupFixture() {
	const directory = await mkdtemp(join(tmpdir(), "stage-quiet-startup-"));
	const uid = (await stat(directory)).uid;
	const lease = await acquireOsOrphanLock({
		lock: join(directory, "control.lock"),
		helper: resolve(
			import.meta.dir,
			"../../../../deployment/ceralive-os-stage-guard",
		),
	});
	let released: Promise<void> | undefined;
	const surrender = () => (released ??= lease[Symbol.asyncDispose]());
	const fixture = rockHelperFixture([]);
	return {
		lease,
		surrender,
		dispose: async () => {
			await surrender();
			await rm(directory, { recursive: true, force: true });
		},
		deps: {
			acquireControl: async () => ({
				...lease,
				[Symbol.asyncDispose]: surrender,
			}),
			readJob: async () => null,
			run: async () => ({
				exitCode: 0,
				stdout: "LoadState=not-found\n",
				stderr: "",
			}),
			liveProducer: () => null,
			orphan: (
				record: Parameters<typeof settleOsStageOrphan>[0],
				control: typeof lease | undefined,
			) =>
				settleOsStageOrphan(record, {
					...(control ? { control } : {}),
					directory: join(directory, "absent-job"),
					uid,
					lock: acquireOsOrphanLock,
					run: fixture.deps.run,
					observe: () => {
						throw new Error("absent directory must not observe a writer");
					},
					cliGone: async () => true,
					sweep: async () => {
						throw new Error("absent directory delegates its sweep to startup");
					},
					liveProducer: () => null,
				}),
		},
	};
}

test.each(["lease", "deadline"] as const)(
	"quiet startup keeps admission closed when its held sweep loses %s",
	async (loss) => {
		// Given actual absent-directory orphan handling and a real flock-backed CONTROL lease.
		const h = await quietStartupFixture();
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const commands: string[] = [];
		let offset = 0;
		const work = reconcileOsStageStartup({
			...h.deps,
			now: () => performance.now() + offset,
			sweep: (read) =>
				sweepUpdateRules(async (_bin, args) => {
					commands.push(`${h.lease.held()}:${args.join(" ")}`);
					if (args.join(" ") === "rule show") {
						if (loss === "deadline") offset = 9_960;
						entered.resolve();
						await gate.promise;
						return "120: from all uidrange 42043-42043 lookup 100001\n";
					}
					return "";
				}, read),
		}).then(
			() => "opened",
			(error: unknown) => error,
		);
		try {
			expect(
				await Promise.race([entered.promise.then(() => "entered"), work]),
			).toBe("entered");
			// When the query is held across actual lease surrender or the remaining 40 ms.
			switch (loss) {
				case "lease":
					await h.surrender();
					gate.resolve();
					break;
				case "deadline":
					break;
				default:
					throw new Error(loss satisfies never);
			}
			const settled = await Promise.race([
				work,
				Bun.sleep(160).then(() => "pending"),
			]);
			gate.resolve();
			await work;
			await Bun.sleep(0);
			// Then no deletion, next query or flush escapes, and admission stays closed.
			expect(commands).toEqual(["true:rule show"]);
			expect(settled).toHaveProperty("mode", "unsafe");
			expect(h.lease.held()).toBe(false);
			expect(osUpdateAdmissionReady()).toBe(false);
		} finally {
			gate.resolve();
			await work;
			await h.dispose();
		}
	},
);

test("quiet startup sweeps stale routing and opens admission under live authority", async () => {
	// Given absent job/directory/guardian and a real CONTROL helper.
	const h = await quietStartupFixture();
	const commands: string[] = [];
	try {
		// When normal startup sweeps the existing UID rule and both family tables.
		const result = await reconcileOsStageStartup({
			...h.deps,
			sweep: (read) =>
				sweepUpdateRules(async (_bin, args) => {
					commands.push(`${h.lease.held()}:${args.join(" ")}`);
					return args.join(" ") === "rule show"
						? "120: from all uidrange 42043-42043 lookup 100001\n"
						: "";
				}, read),
		});
		// Then cleanup completes normally, with every command submitted under CONTROL.
		expect(result).toEqual({ kind: "none" });
		expect(osUpdateAdmissionReady()).toBe(true);
		expect(commands).toEqual([
			"true:rule show",
			"true:rule del priority 120 uidrange 42043-42043 lookup 100001",
			"true:-6 rule show",
			"true:route flush table 100000",
			"true:route flush table 100001",
			"true:-6 route flush table 100000",
			"true:-6 route flush table 100001",
		]);
	} finally {
		await h.dispose();
	}
});

test("quiet startup re-evaluates the final clock immediately before admission", async () => {
	// Given a completed sweep whose last bounded-read clock is still valid.
	const h = await quietStartupFixture();
	let sweepFinished = false;
	let finalClocks = 0;
	try {
		// When the next clock at the authorization boundary reaches the fixed deadline.
		await expect(
			reconcileOsStageStartup({
				...h.deps,
				now: () => (sweepFinished && ++finalClocks >= 3 ? 10_000 : 0),
				sweep: async () => {
					sweepFinished = true;
				},
			}),
		).rejects.toHaveProperty("diagnostics.refusal", "deadline-expired");
		// Then successful cleanup does not authorize expired admission.
		expect(osUpdateAdmissionReady()).toBe(false);
	} finally {
		await h.dispose();
	}
});

test.each(["lease", "deadline"] as const)(
	"quiet startup rechecks %s before opening admission after sweep",
	async (loss) => {
		// Given clean startup whose sweep completes without a command executor callback.
		const h = await quietStartupFixture();
		let offset = 0;
		try {
			// When authority expires at the aggregate sweep's return boundary.
			await expect(
				reconcileOsStageStartup({
					...h.deps,
					now: () => performance.now() + offset,
					sweep: async () => {
						switch (loss) {
							case "lease":
								await h.surrender();
								break;
							case "deadline":
								offset = 10_000;
								break;
							default:
								throw new Error(loss satisfies never);
						}
					},
				}),
			).rejects.toHaveProperty("mode", "unsafe");
			// Then even a fulfilled sweep cannot grant stale admission authority.
			expect(osUpdateAdmissionReady()).toBe(false);
		} finally {
			await h.dispose();
		}
	},
);
