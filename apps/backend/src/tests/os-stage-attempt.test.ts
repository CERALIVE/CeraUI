import { describe, expect, test } from "bun:test";
import { beginOsStageAttempt } from "../modules/system/update-orchestrator/os-stage-attempt.ts";
import {
	classifyPinnedTopology,
	type OsHttpsHealth,
	type OsPinHealth,
	probePinnedBundle,
} from "../modules/system/update-orchestrator/os-stage-path.ts";
import { rankTransports } from "../modules/system/update-transport/core.ts";
import { UpdateTransferError } from "../modules/system/update-transport/pin.ts";

const selection = rankTransports([
	{
		candidate: { ifname: "wlan0", kind: "wifi", metered: false },
		family: 4,
		hosts: [{ host: "fixture", state: "clear", latencyMs: 1 }],
	},
]);
if (selection.status !== "selected") throw new Error("fixture ranking");
const transport = selection.selected;
const good = {
	transport,
	links: '[{"ifname":"wlan0","flags":["UP","LOWER_UP"]}]',
	addresses:
		'[{"addr_info":[{"family":"inet","scope":"global","local":"192.168.78.169"}]}]',
	routes: '[{"dst":"default","dev":"wlan0"}]',
	carrier: "1\n",
};
const tick = async () => {
	for (let i = 0; i < 8; i++) await Promise.resolve();
};

function harness() {
	const clock = new Map<number, () => void>();
	const control = new AbortController();
	let topology: OsPinHealth = { kind: "healthy" };
	let https: OsHttpsHealth = { kind: "healthy" };
	let resolveCli: (value: {
		exitCode: number;
		stdout: string;
		stderr: string;
	}) => void = () => {};
	let calls = 0;
	const cli = new Promise<{ exitCode: number; stdout: string; stderr: string }>(
		(resolve) => {
			resolveCli = resolve;
		},
	);
	const attempt = beginOsStageAttempt(
		{
			url: "https://images.ceralive.tv/releases/rock-5b-plus/2026.10.51/bundle.raucb",
			transport,
			control: { attemptId: "attempt-1", signal: control.signal },
		},
		{
			run: () => {
				calls++;
				return cli;
			},
			topology: async () => topology,
			https: async () => https,
			every: (ms, action) => {
				clock.set(ms, action);
				return () => clock.delete(ms);
			},
		},
	);
	return {
		attempt,
		control,
		clock,
		calls: () => calls,
		setTopology: (next: OsPinHealth) => {
			topology = next;
		},
		setHttps: (next: OsHttpsHealth) => {
			https = next;
		},
		settle: (exitCode = 0) =>
			resolveCli({
				exitCode,
				stdout: "",
				stderr: exitCode ? "Unexpected end of file; status=7/BUS" : "",
			}),
	};
}

describe("independent pinned-path watcher", () => {
	test("C3 detects hard-down without waiting for the flat-56 progress or unsettled CLI", async () => {
		// Given Rock C3-watch.tsv:93-95: progress 56 at 08:36:16.076,
		// MANUAL-FIRE 08:36:17.905, wlan0=down at 08:36:18.164; journal:37-45
		// later records EOF/SIGBUS and daemon 425061, not a failover receipt.
		const h = harness();
		h.setTopology({ kind: "lost", reason: "admin-down" });
		// When the first fresh 3-second health poll observes the lost pinned path.
		h.clock.get(3000)?.();
		await tick();
		// Then detection settles independently while the CLI remains unsettled.
		expect(await h.attempt.outcome).toMatchObject({
			kind: "failed",
			error: {
				reason: "os_transport_failed",
				diagnostics: { loss: "admin-down" },
			},
		});
		expect(h.attempt.cliSettled()).toBe(false);
		h.settle(1);
		await h.attempt.cli;
	});

	test("healthy flat-56 progress and flat RX never abort a stage", async () => {
		// Given the healthy chunk-copy period in C3-watch.tsv:38-93 stayed at 56.
		const h = harness();
		// When hundreds of unchanged observations arrive while CLI work continues.
		for (let i = 0; i < 200; i++) {
			h.clock.get(3000)?.();
			h.clock.get(10000)?.();
			await tick();
		}
		h.settle();
		// Then the confirmed CLI result remains success; no progress/RX heuristic exists.
		expect(await h.attempt.outcome).toMatchObject({ kind: "succeeded" });
	});

	test.each(["unknown", "healthy"] as const)(
		"%s topology is not transport failure",
		async (kind) => {
			// Given no positive loss observation, when the CLI returns a generic failure.
			const h = harness();
			h.setTopology({ kind });
			h.clock.get(3000)?.();
			await tick();
			h.settle(1);
			// Then SIGBUS/EOF by themselves never justify unhealthy-link attribution.
			expect(await h.attempt.outcome).toMatchObject({
				kind: "failed",
				error: { reason: "rauc_install_failed", mode: "operator" },
			});
		},
	);

	test("two consecutive HTTPS transport failures cancel, but one transient does not", async () => {
		// Given an initial transport failure followed by successful HEAD.
		const h = harness();
		h.setHttps({
			kind: "transport",
			error: new UpdateTransferError("blocked"),
		});
		// When a success resets the run, followed by two consecutive failures.
		h.clock.get(10000)?.();
		await tick();
		h.setHttps({ kind: "healthy" });
		h.clock.get(10000)?.();
		await tick();
		h.setHttps({
			kind: "transport",
			error: new UpdateTransferError("blocked"),
		});
		h.clock.get(10000)?.();
		await tick();
		expect(h.clock.has(10000)).toBe(true);
		h.clock.get(10000)?.();
		await tick();
		// Then only the second consecutive failure settles transport loss.
		expect(await h.attempt.outcome).toMatchObject({
			kind: "failed",
			error: { reason: "os_transport_failed" },
			transfer: { reason: "blocked" },
		});
		h.settle(1);
		await h.attempt.cli;
	});

	test("origin 503 is automatic later-retry without a transport verdict", async () => {
		// Given a verified HTTPS origin refusal, when HEAD observes it.
		const h = harness();
		h.setHttps({ kind: "origin", status: 503 });
		h.clock.get(10000)?.();
		await tick();
		// Then no failed pair can be attributed to the origin outage.
		expect(await h.attempt.outcome).toMatchObject({
			kind: "failed",
			error: { reason: "os_origin_unavailable", mode: "automatic" },
		});
		h.settle(1);
		await h.attempt.cli;
	});

	test("stream cancellation beats the simultaneous lost-link observation", async () => {
		// Given a health read resolving in the same turn as D8 cancellation.
		const h = harness();
		h.setTopology({ kind: "lost", reason: "admin-down" });
		// When cancellation reaches the stable attempt signal first.
		h.clock.get(3000)?.();
		h.control.abort();
		await tick();
		// Then the result is cancelled, not a transfer failure, and all watches retire.
		expect(await h.attempt.outcome).toMatchObject({
			kind: "failed",
			error: { reason: "os_stage_cancelled_for_stream", mode: "cancelled" },
		});
		expect(h.clock.size).toBe(0);
		h.settle(1);
		await h.attempt.cli;
	});
});

test.each([
	["interface-removed", { links: "[]" }],
	["admin-down", { links: '[{"ifname":"wlan0","flags":[]}]' }],
	["carrier-down", { carrier: "0" }],
	["family-address-lost", { addresses: '[{"addr_info":[]}]' }],
	[
		"private-route-lost",
		{ routes: '[{"dst":"default","type":"unreachable"}]' },
	],
] as const satisfies readonly (readonly [string, Partial<typeof good>])[])(
	"fresh %s is positive hard loss",
	(reason, patch) => {
		// Given one definitive kernel fact, when classifying the fresh topology.
		const result = classifyPinnedTopology({ ...good, ...patch });
		// Then its exact loss reason is retained.
		expect(result).toEqual({ kind: "lost", reason });
	},
);

test.each([404, 410, 302])(
	"HEAD response %i cannot become network evidence",
	async (code) => {
		// Given a verified unsupported/missing HTTP response, when probing through the OTA UID.
		let argv: string[] = [];
		const result = await probePinnedBundle(
			"https://images.ceralive.tv/releases/fixture/bundle.raucb",
			transport,
			async (input) => {
				argv = input;
				return { exitCode: 0, stdout: String(code), stderr: "" };
			},
		);
		// Then no network verdict is invented and TLS/family/UID remain explicit.
		expect(result).toEqual({ kind: "unavailable" });
		expect(argv.slice(0, 6)).toEqual([
			"runuser",
			"-u",
			"ceralive-ota",
			"--",
			"curl",
			"-q",
		]);
		expect(argv).toContain("-4");
		expect(argv).not.toContain("--insecure");
	},
);
