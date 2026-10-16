import { afterEach, describe, expect, test } from "bun:test";
import type { SpawnWithTimeoutResult } from "../helpers/spawn-policy.ts";
import { abortAptTransferForStream } from "../modules/system/apt-transfer-abort.ts";
import {
	classifyAptFetchFailure,
	openPinnedAptTransaction,
	reachabilityFromSelection,
	setAptTransportDepsForTest,
} from "../modules/system/apt-transport.ts";
import {
	rankTransports,
	type TransportSample,
} from "../modules/system/update-transport/core.ts";
import {
	FETCH_FAILURE,
	pinFixture,
	sample,
} from "./helpers/apt-transport-fixture.ts";

afterEach(() => setAptTransportDepsForTest(null));

const RANKED = [sample("eth0", "ethernet", 6), sample("wlan0", "wifi", 4)];
const OK: SpawnWithTimeoutResult = {
	exitCode: 0,
	stdout: "Get:1 https://apt.ceralive.tv stable/main a 1 [4 kB]\n",
	stderr: "",
};
const LOCKED: SpawnWithTimeoutResult = {
	exitCode: 100,
	stdout: "",
	stderr: "E: Could not get lock /var/cache/apt/archives/lock\n",
};

async function open(samples: readonly TransportSample[], swept = true) {
	const fixture = await pinFixture(swept);
	setAptTransportDepsForTest({
		select: async () => rankTransports(samples),
		pin: fixture.pin,
	});
	return { ...fixture, tx: await openPinnedAptTransaction() };
}

describe("pinned APT transfer", () => {
	test("pins the winner's family, then fails over on an apt fetch failure", async () => {
		// Given IPv6 Ethernet ranks first and its fetch cannot connect.
		const { tx, active } = await open(RANKED);
		const seen: string[] = [];
		// When the transfer runs.
		const result = await tx.transfer(async ({ verdict }) => {
			seen.push(`${verdict}:${active()}`);
			return seen.length === 1 ? FETCH_FAILURE : OK;
		});
		// Then each attempt ran under its own rule and nothing stays routed.
		expect(seen).toEqual(["force_ipv6:true", "force_ipv4:true"]);
		expect(result).toBe(OK);
		expect(active()).toBe(false);
	});

	test("returns a non-network apt failure without moving to another pair", async () => {
		// Given the first pair answers with a local apt lock failure.
		const { tx } = await open(RANKED);
		let attempts = 0;
		// When the transfer runs.
		const result = await tx.transfer(async () => {
			attempts++;
			return LOCKED;
		});
		// Then the caller sees that failure from the only attempt.
		expect(result).toBe(LOCKED);
		expect(attempts).toBe(1);
	});

	test("returns the last fetch failure once every healthy pair failed", async () => {
		// Given both pairs fail to fetch.
		const { tx } = await open(RANKED);
		const failures = [FETCH_FAILURE, { ...FETCH_FAILURE, exitCode: 101 }];
		let attempt = 0;
		// When the transfer runs.
		const result = await tx.transfer(async () => failures[attempt++] ?? OK);
		// Then the existing apt failure path receives the final attempt's result.
		expect(attempt).toBe(2);
		expect(result.exitCode).toBe(101);
	});

	test("a stream-start abort kills the transfer and tears its rule down", async () => {
		// Given an abortable transfer is fetching under the pin.
		const { tx, active } = await open(RANKED);
		const started = Promise.withResolvers<void>();
		let attempts = 0;
		const pending = tx.transfer(
			async (_attempt, signal) => {
				attempts++;
				started.resolve();
				await new Promise((resolve) =>
					signal?.addEventListener("abort", resolve),
				);
				return FETCH_FAILURE;
			},
			{ abortable: true },
		);
		await started.promise;
		expect(active()).toBe(true);
		// When a stream start aborts it.
		abortAptTransferForStream();
		await pending;
		// Then the rule is gone, no other pair was tried, and the abort is visible.
		expect(active()).toBe(false);
		expect(attempts).toBe(1);
		expect(tx.aborted()).toBe(true);
	});
});

describe("pinned APT local work", () => {
	test("holds the rule only while the work runs and never fails over a coded error", async () => {
		// Given local work that throws an error carrying a curl-like code.
		const { tx, active } = await open(RANKED);
		const coded = Object.assign(new Error("local"), { code: 7 });
		const seen: boolean[] = [];
		// When it runs within the transaction.
		const outcome = tx
			.within(
				async () => {
					seen.push(active());
					throw coded;
				},
				() => "refused",
			)
			.catch((error: unknown) => error);
		// Then the same error surfaces after teardown, from one attempt.
		expect(await outcome).toBe(coded);
		expect(seen).toEqual([true]);
		expect(active()).toBe(false);
	});

	test("answers a routing refusal with the caller's refusal", async () => {
		// Given startup never swept the update rules.
		const { tx } = await open(RANKED, false);
		// When local work asks for the pin.
		const outcome = await tx.within(
			async () => "ran",
			() => "refused",
		);
		// Then the work never ran.
		expect(outcome).toBe("refused");
	});
});

describe("selection verdict", () => {
	test.each([
		[RANKED, "force_ipv6", "ok", "ok", "ipv6"],
		[
			[
				sample("eth0", "ethernet", 4, "captive-http"),
				sample("eth0", "ethernet", 6, "no-route"),
			],
			"captive_portal",
			"captive",
			"no_route",
			"none",
		],
		[
			[sample("eth0", "ethernet", 4, "credentials-invalid")],
			"credentials_invalid",
			"credentials_invalid",
			"unknown",
			"none",
		],
		[
			[sample("eth0", "ethernet", 6, "probe-unavailable")],
			"probe_unavailable",
			"unknown",
			"probe_unavailable",
			"none",
		],
		[[], "unreachable", "unknown", "unknown", "none"],
	] as const)(
		"selection case %# folds into its gate verdict",
		(samples, verdict, ipv4, ipv6, used) => {
			// Given a ranked selection; When it is folded; Then the gates read this verdict.
			expect(reachabilityFromSelection(rankTransports(samples))).toMatchObject({
				verdict,
				ipv4,
				ipv6,
				used,
			});
		},
	);

	test.each([
		[
			"W: Failed to fetch x  Temporary failure resolving 'deb.debian.org'",
			0,
			"dns-failed",
		],
		["E: Failed to fetch x  Certificate verification failed", 100, "tls-error"],
		[
			"E: Failed to fetch x  Could not connect to h:443 (1.2.3.4), connection timed out",
			100,
			"blocked",
		],
		[
			"E: Failed to fetch x  Clearsigned file isn't valid, got 'NOSPLIT' (does the network require authentication?)",
			100,
			"blocked",
		],
		[FETCH_FAILURE.stderr, 100, "no-route"],
		[LOCKED.stderr, 100, undefined],
	] as const)(
		"apt stderr case %# classifies to its reason",
		(stderr, exitCode, reason) => {
			// Given apt's stderr; When classified; Then only fetch failures move pairs.
			expect(classifyAptFetchFailure({ exitCode, stdout: "", stderr })).toBe(
				reason,
			);
		},
	);
});
