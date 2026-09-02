/*
 * WHERE AN UPLINK-HEALTH PROBE IS AIMED, and what that decides.
 *
 * The runtime used to aim every device-bound probe at a hardcoded `1.1.1.1`
 * while carrying `internet.ts`'s `Host: www.gstatic.com` + `/generate_204`
 * contract. Cloudflare does not serve that path, so it answers a 3xx/HTML
 * redirect; `device-bound-probe.ts` reads a 3xx-or-bodied answer as a captive
 * portal (correctly, given what it was handed); `model.ts` makes captive
 * interception INSTANTLY `degraded` and ZEROES the success counter — so the
 * recovery rule (5 successes plus a 15 s dwell) could never be satisfied and
 * every healthy probed uplink read permanently Degraded.
 *
 * The regression pair below is the load-bearing part: ONE wire fixture, keyed on
 * the argv's destination, driven through the REAL `probeConnectivityViaDevice`.
 * Against the OLD target it still classifies captive — that arm LOCKS the bug
 * rather than deleting it — and against the resolved target the SAME fixture
 * classifies from the real answer. The genuine-captive-portal negative proves
 * the fix did not weaken the detection it depends on.
 */

import { describe, expect, mock, test } from "bun:test";

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import {
	type DeviceBoundProbeDeps,
	PROBE_STATUS_MARKER,
	probeConnectivityViaDevice,
} from "../modules/network/device-bound-probe.ts";
import type { NetworkInterface } from "../modules/network/network-interfaces.ts";
import {
	CONNECTIVITY_TARGET_TTL_MS,
	createConnectivityTargetResolver,
	setUplinkHealthEngineForTest,
	UPLINK_HEALTH_CONFIG,
	UplinkHealthEngine,
	type UplinkHealthOutcome,
	UplinkHealthRuntime,
} from "../modules/network/uplink-health/index.ts";

/** The address the retired code hardcoded. Kept ONLY to reproduce its answer. */
const RETIRED_HARDCODED_TARGET = "1.1.1.1";

/** An externally-resolved `www.gstatic.com` A record, as DNS really answers. */
const RESOLVED_TARGET = "142.251.133.99";

const IFACE = "wwan0";

function netif(over: Partial<NetworkInterface> = {}): NetworkInterface {
	return {
		ip: "10.0.0.2",
		tp: 0,
		txb: 0,
		rxb: 0,
		enabled: true,
		error: 0,
		...over,
	};
}

/**
 * Cloudflare's real shape for `GET /generate_204` with a `Host:` it does not
 * serve — a redirect carrying a body. This is the wire answer the retired target
 * produced on every round, on every board.
 */
const CLOUDFLARE_REDIRECT = `<html>\n<head><title>301 Moved Permanently</title></head>\n<body>\n<center><h1>301 Moved Permanently</h1></center>\n<hr><center>cloudflare</center>\n</body>\n</html>${PROBE_STATUS_MARKER}301`;

/** What an address that DOES serve the check answers: 204, empty body. */
const CLEAN_204 = `${PROBE_STATUS_MARKER}204`;

/** A real sign-in portal: an interception, and still classified as one. */
const CAPTIVE_PORTAL = `<html><body>Sign in to continue</body></html>${PROBE_STATUS_MARKER}302`;

/**
 * ONE fixture for BOTH arms of the regression pair: it answers by DESTINATION,
 * so the only thing that differs between the two arms is where the probe was
 * aimed. Handing each arm its own canned stdout would prove nothing about the
 * target.
 */
function wireFixture(
	overrides: Record<string, string> = {},
): DeviceBoundProbeDeps & { readonly targets: string[] } {
	const byDestination: Record<string, string> = {
		[RETIRED_HARDCODED_TARGET]: CLOUDFLARE_REDIRECT,
		[RESOLVED_TARGET]: CLEAN_204,
		...overrides,
	};
	const targets: string[] = [];
	return {
		targets,
		shouldUseMocks: () => false,
		runProbe: async (argv: string[]): Promise<SpawnWithTimeoutResult> => {
			const url = argv.at(-1) ?? "";
			const destination = url.replace(/^http:\/\//, "").split("/")[0] ?? "";
			targets.push(destination);
			return {
				exitCode: 0,
				stdout: byDestination[destination] ?? "",
				stderr: "",
				timedOut: false,
			} as SpawnWithTimeoutResult;
		},
	};
}

describe("the probe target decides the verdict (regression pair)", () => {
	test("the RETIRED hardcoded target classifies a Cloudflare 301 as captive", async () => {
		// Given the wire answer the retired target really produced
		const deps = wireFixture();

		// When the probe is aimed where the retired code aimed it
		const verdict = await probeConnectivityViaDevice(
			RETIRED_HARDCODED_TARGET,
			IFACE,
			deps,
		);

		// Then the misclassification is reproduced, not merely asserted about
		expect(verdict).toBe("captive_portal");
		expect(deps.targets).toEqual([RETIRED_HARDCODED_TARGET]);
	});

	test("the SAME fixture classifies from the real answer at the resolved target", async () => {
		// Given the identical wire fixture
		const deps = wireFixture();

		// When the probe is aimed at the resolved connectivity-check address
		const verdict = await probeConnectivityViaDevice(
			RESOLVED_TARGET,
			IFACE,
			deps,
		);

		// Then it reads the address's own 204, so the link is reachable
		expect(verdict).toBe("reachable");
		expect(deps.targets).toEqual([RESOLVED_TARGET]);
	});

	test("a GENUINE captive portal at the resolved target still classifies captive", async () => {
		// Given the resolved target intercepted by a real sign-in portal
		const deps = wireFixture({ [RESOLVED_TARGET]: CAPTIVE_PORTAL });

		// When probed
		const verdict = await probeConnectivityViaDevice(
			RESOLVED_TARGET,
			IFACE,
			deps,
		);

		// Then the detection this fix depends on is unweakened
		expect(verdict).toBe("captive_portal");
	});
});

// ─── The runtime, end to end ─────────────────────────────────────────────────

interface RuntimeHarness {
	readonly runtime: UplinkHealthRuntime;
	readonly engine: UplinkHealthEngine;
	readonly probed: string[];
	advance: (ms: number) => void;
}

function harness(
	target: string | undefined,
	probeDeps: DeviceBoundProbeDeps,
	resolveTarget?: () => Promise<string | undefined>,
): RuntimeHarness {
	const engine = new UplinkHealthEngine();
	setUplinkHealthEngineForTest(engine);
	let clock = 1_000;
	const probed: string[] = [];
	const runtime = new UplinkHealthRuntime({
		now: () => clock,
		interfaces: () => ({ [IFACE]: netif() }),
		streaming: () => false,
		telemetry: () => null,
		resolveTarget: resolveTarget ?? (() => Promise.resolve(target)),
		probe: async (iface, remoteAddr): Promise<UplinkHealthOutcome> => {
			probed.push(remoteAddr);
			const verdict = await probeConnectivityViaDevice(
				remoteAddr,
				iface,
				probeDeps,
			);
			return verdict === "reachable"
				? "success"
				: verdict === "captive_portal"
					? "captive_portal"
					: "failure";
		},
		publish: () => undefined,
	});
	return {
		runtime,
		engine,
		probed,
		advance: (ms) => {
			clock += ms;
		},
	};
}

describe("uplink-health runtime — the round reaches the resolved address", () => {
	test("a healthy uplink reads UP, and its probes go to the resolved address", async () => {
		// Given a resolved target that serves the check
		const h = harness(RESOLVED_TARGET, wireFixture());

		// When a round runs
		await h.runtime.tick();

		// Then the link is up and nothing was aimed at the retired literal
		expect(h.engine.get(IFACE)).toMatchObject({ state: "up" });
		expect(h.probed).toEqual([RESOLVED_TARGET]);
		expect(h.probed).not.toContain(RETIRED_HARDCODED_TARGET);
	});

	test("the RETIRED target degrades a healthy link and makes recovery unreachable", async () => {
		// Given the retired hardcoded target against the same healthy wire
		const h = harness(RETIRED_HARDCODED_TARGET, wireFixture());

		// When far more rounds run than recovery would ever need
		for (
			let round = 0;
			round < UPLINK_HEALTH_CONFIG.successfulRoundsUp * 3;
			round++
		) {
			await h.runtime.tick();
			h.advance(UPLINK_HEALTH_CONFIG.probeRoundCadenceMs);
		}

		// Then it is permanently degraded with its success counter pinned at zero
		expect(h.engine.get(IFACE)).toMatchObject({
			state: "degraded",
			reason: "captive_portal",
			probes: { successes: 0, failures: 0 },
		});
	});

	test("recovery reaches UP once the dwell and five successes are met", async () => {
		// Given a link the device has taken down
		const h = harness(RESOLVED_TARGET, wireFixture());
		const engine = h.engine;
		for (
			let round = 1;
			round <= UPLINK_HEALTH_CONFIG.failedRoundsDown;
			round++
		) {
			engine.observe({
				iface: IFACE,
				kind: "cellular",
				outcome: "failure",
				now: 1_000,
			});
		}
		expect(engine.get(IFACE)?.state).toBe("down");

		// When the dwell elapses and the resolved target answers 204 five times
		h.advance(UPLINK_HEALTH_CONFIG.holdDownMs + 1);
		for (
			let round = 0;
			round < UPLINK_HEALTH_CONFIG.successfulRoundsUp;
			round++
		) {
			await h.runtime.tick();
		}

		// Then the link is up again — the path the retired target could not reach
		expect(engine.get(IFACE)).toMatchObject({ state: "up", weight: 100 });
		expect(engine.get(IFACE)?.probes.successes).toBeGreaterThanOrEqual(
			UPLINK_HEALTH_CONFIG.successfulRoundsUp,
		);
	});

	test("an unresolvable target SKIPS the round rather than recording a failure", async () => {
		// Given a device whose DNS cannot answer
		const h = harness(undefined, wireFixture());

		// When rounds run
		await h.runtime.tick();
		await h.runtime.tick();

		// Then nothing was probed and nothing was claimed about the uplink
		expect(h.probed).toEqual([]);
		expect(h.engine.get(IFACE)).toBeUndefined();
	});

	test("an interface that lost its address is still reported down while DNS is out", async () => {
		// Given an unresolvable target and an address-less interface
		const engine = new UplinkHealthEngine();
		setUplinkHealthEngineForTest(engine);
		let probes = 0;
		const runtime = new UplinkHealthRuntime({
			now: () => 5_000,
			interfaces: () => ({ [IFACE]: netif({ ip: undefined }) }),
			streaming: () => false,
			telemetry: () => null,
			resolveTarget: () => Promise.resolve(undefined),
			probe: async () => {
				probes++;
				return "failure";
			},
			publish: () => undefined,
		});

		// When a round runs
		await runtime.tick();

		// Then the address loss — independent evidence — is still observed
		expect(probes).toBe(0);
		expect(engine.get(IFACE)).toMatchObject({
			state: "down",
			reason: "definitive_loss",
		});
	});
});

// ─── The resolver's own rules ────────────────────────────────────────────────

describe("connectivity-target resolver", () => {
	test("resolves the check domain and reuses the answer within its TTL", async () => {
		// Given a resolver over a counting DNS double
		const resolve = mock(async () =>
			Promise.resolve({ addrs: [RESOLVED_TARGET], fromCache: false }),
		);
		let clock = 0;
		const target = createConnectivityTargetResolver({
			resolve,
			now: () => clock,
		});

		// When it is asked repeatedly inside the TTL
		expect(await target()).toBe(RESOLVED_TARGET);
		clock += CONNECTIVITY_TARGET_TTL_MS - 1;
		expect(await target()).toBe(RESOLVED_TARGET);

		// Then DNS was asked exactly once
		expect(resolve).toHaveBeenCalledTimes(1);

		// When the TTL elapses
		clock += 2;
		expect(await target()).toBe(RESOLVED_TARGET);

		// Then it asks again
		expect(resolve).toHaveBeenCalledTimes(2);
	});

	test("concurrent callers join ONE in-flight resolution", async () => {
		// Given a slow DNS double
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const resolve = mock(async () => {
			await gate;
			return { addrs: [RESOLVED_TARGET], fromCache: false };
		});
		const target = createConnectivityTargetResolver({
			resolve,
			now: () => 0,
		});

		// When three callers ask before it answers
		const pending = Promise.all([target(), target(), target()]);
		release?.();

		// Then all three get the address from one lookup
		expect(await pending).toEqual([
			RESOLVED_TARGET,
			RESOLVED_TARGET,
			RESOLVED_TARGET,
		]);
		expect(resolve).toHaveBeenCalledTimes(1);
	});

	test("a failed lookup reuses the last resolved address rather than skipping", async () => {
		// Given a resolver that answered once and then loses DNS
		let ok = true;
		const target = createConnectivityTargetResolver({
			resolve: async () => {
				if (!ok)
					throw new Error("DNS query failed and no cached value is available");
				return { addrs: [RESOLVED_TARGET], fromCache: false };
			},
			now: () => (ok ? 0 : CONNECTIVITY_TARGET_TTL_MS + 1),
		});
		expect(await target()).toBe(RESOLVED_TARGET);

		// When DNS stops answering past the TTL
		ok = false;

		// Then the last REAL address is served — stale beats nothing
		expect(await target()).toBe(RESOLVED_TARGET);
	});

	test("a lookup that never succeeded answers undefined, never a guess", async () => {
		// Given a resolver whose every lookup fails
		const target = createConnectivityTargetResolver({
			resolve: async () => {
				throw new Error("DNS query failed and no cached value is available");
			},
			now: () => 0,
		});

		// When asked
		const answer = await target();

		// Then it says so, so the caller skips its round
		expect(answer).toBeUndefined();
	});

	test("an empty answer is a failure, not an empty target", async () => {
		// Given DNS resolving the name to nothing at all
		const target = createConnectivityTargetResolver({
			resolve: async () => ({ addrs: [], fromCache: false }),
			now: () => 0,
		});

		// When asked
		// Then no target is claimed
		expect(await target()).toBeUndefined();
	});
});

// ─── The literal cannot come back ────────────────────────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
const UPLINK_HEALTH_DIR = join(
	HERE,
	"..",
	"modules",
	"network",
	"uplink-health",
);

function stripComments(source: string): string {
	return source
		.replace(/\/\*[\s\S]*?\*\//g, " ")
		.split("\n")
		.filter((line) => !/^\s*(?:\/\/|\*)/.test(line))
		.join("\n");
}

describe("no probe destination is hardcoded in uplink-health", () => {
	const sources = readdirSync(UPLINK_HEALTH_DIR).filter((name) =>
		name.endsWith(".ts"),
	);

	test("scans the whole module, so the assertions below are not vacuous", () => {
		expect(sources).toContain("runtime.ts");
		expect(sources).toContain("connectivity-target.ts");
		expect(sources.length).toBeGreaterThanOrEqual(4);
	});

	test("no executable line carries an IPv4 literal", () => {
		// Prose may name `1.1.1.1` — every module here explains what was removed
		// and why — so the scan is comment-stripped, exactly like the link-id gate.
		const offenders: string[] = [];
		for (const name of sources) {
			const code = stripComments(
				readFileSync(join(UPLINK_HEALTH_DIR, name), "utf8"),
			);
			for (const line of code.split("\n")) {
				if (/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(line))
					offenders.push(`${name}: ${line.trim()}`);
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the detector really would catch a reintroduced literal", () => {
		const planted = stripComments('const target = "1.1.1.1";\n');
		expect(/\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(planted)).toBe(true);
	});
});
