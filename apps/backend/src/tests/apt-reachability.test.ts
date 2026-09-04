import { afterEach, describe, expect, it, jest } from "bun:test";

import {
	APT_REACHABILITY_TTL_MS,
	type AptOrigin,
	type AptOriginProbe,
	buildProbeArgv,
	classifyProbe,
	deriveVerdict,
	parseAptSourceOrigins,
	probeAptReachability,
	resetAptReachabilityCacheForTest,
} from "../modules/system/apt-reachability.ts";

const FIXTURE_DIR = `${import.meta.dir}/fixtures/apt`;

async function fixture(name: string): Promise<string> {
	return Bun.file(`${FIXTURE_DIR}/${name}`).text();
}

function capturedCurl(text: string): {
	readonly exitCode: number;
	readonly stdout: string;
} {
	const lines = text.trim().split(/\r?\n/);
	const exitLine = lines.find((line) => line.startsWith("rc="));
	const statusLine = lines.find((line) => /^\d{3}(?:\s|$)/.test(line));
	return {
		exitCode: Number.parseInt(exitLine?.slice(3) ?? "-1", 10),
		stdout: statusLine ?? "",
	};
}

function origin(host: string, scheme: "http" | "https" = "https"): AptOrigin {
	return {
		url: `${scheme}://${host}`,
		host,
		scheme,
		probeUrl: `${scheme}://${host}/probe`,
	};
}

function probe(
	aptOrigin: AptOrigin,
	ipv4: AptOriginProbe["ipv4"],
	ipv6: AptOriginProbe["ipv6"],
): AptOriginProbe {
	return { origin: aptOrigin, ipv4, ipv6 };
}

afterEach(() => {
	resetAptReachabilityCacheForTest();
	jest.useRealTimers();
});

describe("apt source parsing and curl argv", () => {
	it("parses every captured deb822 source into its HTTP-level probe URL", async () => {
		const text = await fixture("sources.list.d.rock.txt");

		const origins = parseAptSourceOrigins(text);

		expect(origins).toEqual([
			{
				url: "http://deb.debian.org/debian",
				host: "deb.debian.org",
				scheme: "http",
				probeUrl: "http://deb.debian.org/debian/dists/trixie/InRelease",
			},
			{
				url: "http://deb.debian.org/debian-security",
				host: "deb.debian.org",
				scheme: "http",
				probeUrl:
					"http://deb.debian.org/debian-security/dists/trixie-security/InRelease",
			},
			{
				url: "http://deb.debian.org/debian",
				host: "deb.debian.org",
				scheme: "http",
				probeUrl: "http://deb.debian.org/debian/dists/trixie-updates/InRelease",
			},
			{
				url: "https://apt.ceralive.tv/dists/stable/binary-arm64",
				host: "apt.ceralive.tv",
				scheme: "https",
				probeUrl: "https://apt.ceralive.tv/",
			},
		]);
	});

	it("builds the exact bounded family-specific curl argv", () => {
		expect(buildProbeArgv(4, "http://example.test/probe")).toEqual([
			"curl",
			"-4",
			"--connect-timeout",
			"2",
			"--max-time",
			"3",
			"-sS",
			"-I",
			"-o",
			"/dev/null",
			"-w",
			"%{http_code} %{redirect_url}",
			"http://example.test/probe",
		]);
		expect(buildProbeArgv(6, "https://example.test/")[1]).toBe("-6");
	});
});

describe("classifyProbe", () => {
	it("accepts every HTTP response, including the captured first-party 404", async () => {
		const debian = capturedCurl(await fixture("curl-debian-ipv4.txt"));
		const ceralive = capturedCurl(await fixture("curl-ceralive-ipv4.txt"));

		expect(
			classifyProbe({
				...debian,
				originHost: "deb.debian.org",
				scheme: "http",
			}),
		).toBe("ok");
		expect(
			classifyProbe({
				...ceralive,
				originHost: "apt.ceralive.tv",
				scheme: "https",
			}),
		).toBe("ok");
	});

	it("classifies a captured foreign HTTP redirect as captive", async () => {
		const capture = await fixture("apt-update-captive.txt");
		const redirect = capture
			.match(/^Location:\s*(.+)$/m)?.[1]
			?.replace("[REDACTED_FOREIGN_REDIRECT]", "https://portal.invalid/login");

		expect(capture).toContain("NOSPLIT");
		expect(
			classifyProbe({
				exitCode: 0,
				stdout: `302 ${redirect}`,
				originHost: "deb.debian.org",
				scheme: "http",
			}),
		).toBe("captive");
	});

	it("keeps same-host HTTP redirects and all HTTPS redirects usable", () => {
		expect(
			classifyProbe({
				exitCode: 0,
				stdout: "302 http://deb.debian.org/next",
				originHost: "deb.debian.org",
				scheme: "http",
			}),
		).toBe("ok");
		expect(
			classifyProbe({
				exitCode: 0,
				stdout: "302 https://portal.invalid/",
				originHost: "apt.ceralive.tv",
				scheme: "https",
			}),
		).toBe("ok");
	});

	it.each([
		[28, "blocked"],
		[7, "no_route"],
		[6, "dns_failed"],
		[1, "unknown"],
	] as const)("maps curl exit %i to %s", (exitCode, expected) => {
		expect(
			classifyProbe({
				exitCode,
				stdout: "000 ",
				originHost: "example.test",
				scheme: "https",
			}),
		).toBe(expected);
	});
});

describe("deriveVerdict", () => {
	const debian = origin("deb.debian.org", "http");
	const firstParty = origin("apt.ceralive.tv");

	it.each([
		[[probe(debian, "ok", "ok"), probe(firstParty, "ok", "ok")], "any", "any"],
		[
			[probe(debian, "ok", "blocked"), probe(firstParty, "ok", "blocked")],
			"force_ipv4",
			"ipv4",
		],
		[
			[probe(debian, "no_route", "ok"), probe(firstParty, "no_route", "ok")],
			"force_ipv6",
			"ipv6",
		],
		[
			[probe(debian, "no_route", "ok"), probe(firstParty, "ok", "no_route")],
			"unreachable",
			"none",
		],
		[
			[probe(debian, "captive", "blocked"), probe(firstParty, "ok", "blocked")],
			"captive_portal",
			"none",
		],
	] as const)(
		"derives %s with its fixed used value",
		(byOrigin, verdict, used) => {
			const result = deriveVerdict(byOrigin);
			expect(result.verdict).toBe(verdict);
			expect(result.used).toBe(used);
		},
	);

	it.each([
		{
			name: "one captive IPv6 origin leaves the complete IPv4 path usable",
			byOrigin: [probe(firstParty, "ok", "ok"), probe(debian, "ok", "captive")],
			expected: {
				ipv4: "ok",
				ipv6: "captive",
				verdict: "force_ipv4",
				used: "ipv4",
			},
			detail: [{ origin: debian.url, family: "ipv6", result: "captive" }],
		},
		{
			name: "split successes cannot complete one apt refresh",
			byOrigin: [
				probe(firstParty, "no_route", "ok"),
				probe(debian, "ok", "no_route"),
			],
			expected: {
				ipv4: "no_route",
				ipv6: "no_route",
				verdict: "unreachable",
				used: "none",
			},
			detail: [
				{ origin: firstParty.url, family: "ipv4", result: "no_route" },
				{ origin: debian.url, family: "ipv6", result: "no_route" },
			],
		},
		{
			name: "the captured Rock shape reports its captive IPv4 mirror",
			byOrigin: [
				probe(firstParty, "ok", "blocked"),
				probe(debian, "captive", "blocked"),
			],
			expected: {
				ipv4: "captive",
				ipv6: "blocked",
				verdict: "captive_portal",
				used: "none",
			},
			detail: [
				{ origin: firstParty.url, family: "ipv6", result: "blocked" },
				{ origin: debian.url, family: "ipv4", result: "captive" },
				{ origin: debian.url, family: "ipv6", result: "blocked" },
			],
		},
		{
			name: "a captive Debian mirror on both families dominates both folds",
			byOrigin: [
				probe(firstParty, "ok", "ok"),
				probe(debian, "captive", "captive"),
			],
			expected: {
				ipv4: "captive",
				ipv6: "captive",
				verdict: "captive_portal",
				used: "none",
			},
			detail: [
				{ origin: debian.url, family: "ipv4", result: "captive" },
				{ origin: debian.url, family: "ipv6", result: "captive" },
			],
		},
	] as const)("$name", ({ byOrigin, expected, detail }) => {
		const result = deriveVerdict(byOrigin);
		expect(result).toMatchObject(expected);
		expect(result.detail).toEqual(detail);
	});
});

describe("probeAptReachability", () => {
	it("runs both families for every captured source and derives the OPi force-IPv4 verdict", async () => {
		const sources = await fixture("sources.list.d.rock.txt");
		const ipv4 = capturedCurl(await fixture("curl-debian-ipv4.txt"));
		const ipv6 = capturedCurl(await fixture("curl-debian-ipv6.txt"));
		let calls = 0;

		const result = await probeAptReachability({
			readSources: async () => sources,
			runProbe: async (argv) => {
				calls += 1;
				return argv.includes("-4") ? ipv4 : ipv6;
			},
		});

		expect(result).toMatchObject({
			ipv4: "ok",
			ipv6: "no_route",
			verdict: "force_ipv4",
			used: "ipv4",
		});
		expect(calls).toBe(8);
	});

	it("resolves concurrent transfer timeouts inside the curl budget", async () => {
		jest.useFakeTimers();
		const startedAt = performance.now();
		const pending = probeAptReachability({
			readSources: async () => "URIs: https://apt.ceralive.tv\nSuites: ./",
			runProbe: async () => {
				await new Promise((resolve) => setTimeout(resolve, 3_000));
				return { exitCode: 28, stdout: "000 " };
			},
		});
		await Promise.resolve();

		jest.advanceTimersByTime(3_000);
		const result = await pending;

		expect(result).toMatchObject({ verdict: "unreachable", used: "none" });
		expect(performance.now() - startedAt).toBeLessThan(3_500);
	});

	it("uses the 60-second cache and reset forces a fresh probe", async () => {
		let now = 10_000;
		let calls = 0;
		const deps = {
			readSources: async () => "URIs: https://apt.ceralive.tv\nSuites: ./",
			runProbe: async () => {
				calls += 1;
				return { exitCode: 0, stdout: "404 " };
			},
			now: () => now,
		};

		await probeAptReachability(deps);
		now += APT_REACHABILITY_TTL_MS - 1;
		await probeAptReachability(deps);
		expect(calls).toBe(2);

		resetAptReachabilityCacheForTest();
		await probeAptReachability(deps);
		expect(calls).toBe(4);
	});

	it("contains no persistent address-family mutation surface", async () => {
		const sourcePath =
			process.env.APT_REACHABILITY_SOURCE_UNDER_TEST ??
			`${import.meta.dir}/../modules/system/apt-reachability.ts`;
		const source = await Bun.file(sourcePath).text();
		const executable = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		for (const forbidden of [
			"/etc/apt/apt.conf",
			"gai.conf",
			"sysctl",
			"disable_ipv6",
			"writeFile",
			"Bun.write",
			"--interface",
		]) {
			expect(executable).not.toContain(forbidden);
		}
		expect(executable.match(/\/etc\/apt\//g)).toEqual(["/etc/apt/"]);
		expect(executable).toContain("/etc/apt/sources.list.d");
	});
});
