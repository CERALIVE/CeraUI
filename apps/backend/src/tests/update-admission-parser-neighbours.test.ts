import { expect, spyOn, test } from "bun:test";
import {
	classifyProbe,
	deriveVerdict,
	parseAptSourceOrigins,
} from "../modules/system/apt-reachability.ts";
import {
	defaultOsChannelDeps,
	resolveOsChannel,
} from "../modules/system/update-orchestrator/os-manifest.ts";
import * as storage from "../modules/system/update-orchestrator/stored-state-file.ts";

test.each([
	"200garbage",
	"200\nextra",
	"200\n<<<apt-probe>>>500",
	"+200",
	"200.0",
])("first-party probe cannot grant reachability from status %s", (status) => {
	// Given verified-certificate JSON but ambiguous curl framing.
	const origin = {
		url: "https://apt.ceralive.tv",
		host: "apt.ceralive.tv",
		scheme: "https",
		probeUrl: "https://apt.ceralive.tv/__tls-probe",
	} as const;
	// When the production parser and family reducer judge both families.
	const parsed = classifyProbe({
		exitCode: 0,
		stdout: `{"certVerified":true}\n<<<apt-probe>>>${status}`,
		originHost: origin.host,
		scheme: origin.scheme,
	});
	const result = deriveVerdict([{ origin, ipv4: parsed, ipv6: parsed }]);
	// Then no usable family or repository success is inferred from a numeric prefix.
	expect(parsed).toBe("unknown");
	expect(result.used).toBe("none");
});

test.each(["200garbage", "+200", "600", "999", "302 invalid-url"])(
	"generic probe cannot grant reachability from %s",
	(stdout) => {
		// Given malformed generic curl output, when parsed, then success is unknown.
		expect(
			classifyProbe({
				exitCode: 0,
				stdout,
				originHost: "deb.debian.org",
				scheme: "http",
			}),
		).toBe("unknown");
	},
);

test.each(["URIs", "Suites", "Enabled"])(
	"duplicate deb822 %s authority refuses instead of selecting last match",
	(key) => {
		// Given a valid source stanza plus repeated authority, when parsed, then no probe plan is granted.
		const source =
			"URIs: https://apt.ceralive.tv/dists/stable/binary-arm64\nSuites: stable\nEnabled: yes\n";
		const value =
			key === "URIs"
				? "https://deb.debian.org/debian"
				: key === "Suites"
					? "trixie"
					: "no";
		expect(() =>
			parseAptSourceOrigins(`${source}${key}: ${value}\n`),
		).toThrow();
	},
);

test.each(["EIO", "EACCES", "ELOOP"])(
	"unreadable OS override %s cannot select another install channel",
	async (code) => {
		// Given a present override whose evidence cannot be read.
		let selected = 0;
		const result = resolveOsChannel("stable", {
			readOverride: async () => {
				throw Object.assign(new Error("read failed"), { code });
			},
			warn: () => {},
		});
		// When channel selection runs, then it refuses before any channel-consuming effect.
		await expect(
			result.then((channel) => {
				selected++;
				return channel;
			}),
		).rejects.toMatchObject({ reason: "discovery_failed" });
		expect(selected).toBe(0);
	},
);

test.each([
	{ content: "drill\n", uid: 0, mode: 0o644, regular: true },
	{ content: "drill", uid: 1000, mode: 0o644, regular: true },
	{ content: "drill", uid: 0, mode: 0o666, regular: true },
	{ content: "drill", uid: 0, mode: 0o644, regular: false },
])("invalid present OS override refuses channel selection", async (entry) => {
	// Given invalid present channel authority, when resolved, then settings is not a fallback grant.
	await expect(
		resolveOsChannel("beta", {
			readOverride: async () => entry,
			warn: () => {},
		}),
	).rejects.toMatchObject({ reason: "discovery_failed" });
});

test("genuinely absent OS override preserves the settings channel", async () => {
	// Given genuine absence, when resolved, then the existing configured channel remains authoritative.
	expect(
		await resolveOsChannel("beta", {
			readOverride: async () => undefined,
			warn: () => {},
		}),
	).toBe("beta");
});

test("default OS override adapter observes strict read failure instead of path absence fallback", async () => {
	// Given an EIO at the production strict-reader port, when resolved, then optional lstat absence cannot hide it.
	using _read = spyOn(storage, "readStoredStateFile").mockRejectedValueOnce(
		Object.assign(new Error("fixture EIO"), { code: "EIO" }),
	);
	await expect(
		resolveOsChannel("beta", defaultOsChannelDeps),
	).rejects.toMatchObject({ reason: "discovery_failed" });
});

test("deb822 continuation belongs to its current field instead of an earlier identity", () => {
	// Given multiline URIs and suites followed by an unrelated multiline field.
	const source =
		"URIs: https://deb.debian.org/debian\n https://security.debian.org/debian-security\nSuites: trixie\n trixie-updates\nComponents: main\n contrib\n";
	// When origins are parsed, then later fields cannot contaminate the URI or suite evidence.
	expect(parseAptSourceOrigins(source).map(({ probeUrl }) => probeUrl)).toEqual(
		[
			"https://deb.debian.org/debian/dists/trixie/InRelease",
			"https://deb.debian.org/debian/dists/trixie-updates/InRelease",
			"https://security.debian.org/debian-security/dists/trixie/InRelease",
			"https://security.debian.org/debian-security/dists/trixie-updates/InRelease",
		],
	);
});
