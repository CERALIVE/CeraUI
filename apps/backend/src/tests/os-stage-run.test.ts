import { afterEach, expect, test } from "bun:test";
import { OsStageError } from "../modules/system/update-orchestrator/os-stage-error.ts";
import { runOsStageJob } from "../modules/system/update-orchestrator/os-stage-run.ts";
import { UpdateTransferError } from "../modules/system/update-transport/pin.ts";
import { cleanupRecovery } from "./helpers/os-recovery-harness.ts";
import { harness } from "./helpers/os-stage-run-harness.ts";
import { manifest, ranking } from "./helpers/os-stage-run-inputs.ts";

afterEach(cleanupRecovery);

test("one OS job fails over only after old RAUC recovery and pin teardown, then commits synchronously", async () => {
	// Given Ethernet is available only in a refreshed ranking after C3 Wi-Fi loss.
	const h = await harness();
	// When the OS adapter runs the real pin/recovery loop over injected RAUC attempts.
	expect(await runOsStageJob(manifest, h.control, h.deps)).toBe("receipt");
	// Then recovery, teardown, revalidation and new install precede the only commit.
	expect(h.attempts()).toBe(2);
	expect(
		h.events.filter(
			(event) =>
				event === "acquire" ||
				event === "release" ||
				event.startsWith("install:") ||
				event === "select" ||
				event === "restart-submitted" ||
				event === "receipt+serial+OS_STAGED",
		),
	).toEqual([
		"acquire",
		"select",
		"install:1",
		"restart-submitted",
		"select",
		"install:2",
		"receipt+serial+OS_STAGED",
		"release",
	]);
	expect(h.deps.pin.unhealthyUntil("wlan0", 4)).toBe(900000);
	expect(h.events[h.events.indexOf("prepare-receipt") - 1]).toBe(
		"-6 route flush table 100001",
	);
});

test.each(["rauc_install_failed", "os_origin_unavailable"] as const)(
	"%s settles safely without marking the link unhealthy or re-pinning",
	async (reason) => {
		const h = await harness();
		await expect(
			runOsStageJob(manifest, h.control, {
				...h.deps,
				attempt: (input) => {
					const attempt = h.deps.attempt(input);
					return {
						...attempt,
						outcome: Promise.resolve({
							kind: "failed" as const,
							error: new OsStageError(reason, {
								cause: {
									exitCode: 1,
									stderr: "Unexpected end of file; status=7/BUS",
								},
							}),
						}),
					};
				},
			}),
		).rejects.toHaveProperty("reason", reason);
		expect(h.attempts()).toBe(1);
		expect(h.events).toContain("release");
		expect(h.deps.pin.unhealthyUntil("wlan0", 4)).toBeUndefined();
		expect(h.events).not.toContain("prepare-receipt");
	},
);

test("lock contention invokes no selector, pin or installer", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			owner: (record) => ({
				...h.deps.owner(record),
				acquire: async () => {
					throw new OsStageError("os_update_lock_held");
				},
			}),
		}),
	).rejects.toHaveProperty("reason", "os_update_lock_held");
	expect(h.events).toEqual([]);
});

test("one job exhausts at three distinct pairs and returns one typed transport outcome", async () => {
	const h = await harness();
	await expect(
		runOsStageJob(manifest, h.control, {
			...h.deps,
			selection: async () =>
				ranking([
					["wlan0", "eth0", "wwan0", "fourth"][h.attempts()] ?? "fourth",
				]),
			attempt: (input) => {
				const attempt = h.deps.attempt(input);
				return {
					...attempt,
					outcome: Promise.resolve({
						kind: "failed" as const,
						error: new OsStageError("os_transport_failed"),
						transfer: new UpdateTransferError("no-route"),
					}),
				};
			},
		}),
	).rejects.toMatchObject({
		reason: "os_transport_failed",
		diagnostics: { attemptedPairs: "wlan0/4,eth0/4,wwan0/4" },
	});
	expect(h.attempts()).toBe(3);
	expect(h.events.filter((event) => event === "release")).toHaveLength(1);
	expect(h.events).not.toContain("prepare-receipt");
});

test("Wi-Fi failover never spends unapproved cellular data", async () => {
	// Given a healthy metered link is the only refreshed candidate and no grant exists.
	const h = await harness();
	let selections = 0;
	// When Wi-Fi fails safely.
	const job = runOsStageJob(manifest, h.control, {
		...h.deps,
		selection: async () =>
			ranking(++selections === 1 ? ["wlan0"] : ["wwan0"], selections > 1),
	});
	// Then cellular is never invoked or held unhealthy, and settlement is operator-owned.
	await expect(job).rejects.toMatchObject({
		reason: "os_cellular_approval_required",
		mode: "operator",
	});
	expect(h.attempts()).toBe(1);
	expect(h.deps.pin.unhealthyUntil("wwan0", 4)).toBeUndefined();
});
