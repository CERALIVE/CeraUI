import { describe, expect, test } from "bun:test";

// Edge-case hardening for the post-DNS reachability probe
// (modules/streaming/transport/validate.ts). This probe is the relay-validate
// RPC's final reachability gate. The streaming-device-critical invariant is that
// it ALWAYS settles quickly — a dropped/filtered packet, an unreachable host, a
// dead port, or a malformed address must each resolve (or reject) within a hard
// bound, and must NEVER wedge the event loop waiting on the network.

import {
	PROBE_TIMEOUT_MS,
	probeReachability,
} from "../../modules/streaming/transport/validate.ts";

describe("probeReachability: silent peer (dropped/filtered datagram)", () => {
	test("resolves as a timeout failure, bounded by timeoutMs (never hangs)", async () => {
		// A real UDP listener that accepts the probe datagram but never replies —
		// the exact "filtered/silent" condition that must resolve as a timeout,
		// not a hang. Using loopback makes this deterministic (the packet is
		// delivered, so no ICMP refusal is generated).
		const silent = await Bun.udpSocket({
			socket: {
				data(): void {
					/* swallow: never answer the probe */
				},
			},
		});

		const timeoutMs = 200;
		const start = Date.now();
		let result: Awaited<ReturnType<typeof probeReachability>>;
		try {
			result = await probeReachability("127.0.0.1", silent.port, timeoutMs);
		} finally {
			silent.close();
		}
		const elapsed = Date.now() - start;

		expect(result).toEqual({ reachable: false, reason: "timeout" });
		// Self-bounding: it waited (roughly) the timeout, and crucially did NOT
		// run away beyond it. A regression that dropped the timer would hang here.
		expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 50);
		expect(elapsed).toBeLessThan(timeoutMs + 1500);
	});
});

describe("probeReachability: unreachable host (no route / black hole)", () => {
	test("a routable-but-unreachable IP settles as a non-reachable result in time", async () => {
		// 192.0.2.1 is TEST-NET-1 (RFC 5737) — a valid IPv4 literal (so no DNS is
		// attempted) that nothing answers. The probe must conclude "not reachable"
		// within the timeout instead of blocking the validate RPC indefinitely.
		const timeoutMs = 250;
		const start = Date.now();
		const result = await probeReachability("192.0.2.1", 9000, timeoutMs);
		const elapsed = Date.now() - start;

		expect(result.reachable).toBe(false);
		expect(elapsed).toBeLessThan(timeoutMs + 1500);
	});
});

describe("probeReachability: nobody listening on the port", () => {
	test("an unused loopback port resolves as a clean failure within the bound", async () => {
		// Reserve then immediately free an ephemeral port so nothing is listening
		// on it; probing it must surface as a non-reachable result (ICMP port
		// unreachable -> refused on Linux loopback; timeout on platforms that
		// suppress ICMP). Either way it is a clean, bounded validation failure.
		const reaper = await Bun.udpSocket({ socket: { data(): void {} } });
		const deadPort = reaper.port;
		reaper.close();

		const timeoutMs = 400;
		const start = Date.now();
		const result = await probeReachability("127.0.0.1", deadPort, timeoutMs);
		const elapsed = Date.now() - start;

		expect(result.reachable).toBe(false);
		expect(elapsed).toBeLessThan(timeoutMs + 1500);
		// Sanity: the module exposes a sane default ceiling for callers that omit
		// an explicit timeout.
		expect(PROBE_TIMEOUT_MS).toBeGreaterThan(0);
	});
});

describe("probeReachability: malformed address", () => {
	test("a malformed host fails fast instead of hanging the validate RPC", async () => {
		// The probe documents that callers MUST pass an already-resolved address.
		// A malformed/empty host violates that contract; the hardening guarantee
		// is that it surfaces IMMEDIATELY (a fast rejection) rather than silently
		// stalling the reachability gate. Empty-string is DNS-independent, so this
		// is deterministic on any host/CI.
		const start = Date.now();
		await expect(probeReachability("", 9000, 250)).rejects.toThrow();
		const elapsed = Date.now() - start;
		// Fast-fail: nowhere near the timeout — it never armed the probe at all.
		expect(elapsed).toBeLessThan(200);
	});
});
