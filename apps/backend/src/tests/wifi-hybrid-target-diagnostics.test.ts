import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { getRecentLogLines, logger } from "../helpers/logger.ts";
import { getConfig } from "../modules/config.ts";
import {
	notifyWifiAdapterModeDiscovery,
	wifiAdapterModeRestoreSource,
} from "../modules/wifi/wifi-adapter-mode-events.ts";
import { startWifiAdapterModeRestore } from "../modules/wifi/wifi-adapter-mode-restore.ts";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import * as creation from "../modules/wifi/wifi-concurrent-interface-creation.ts";
import * as devices from "../modules/wifi/wifi-device-list.ts";
import { startHotspotLocked } from "../modules/wifi/wifi-hotspot-activation.ts";
import * as policy from "../modules/wifi/wifi-hybrid-target-policy.ts";
import * as records from "../modules/wifi/wifi-hybrid-target-record.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { hybridFixture, MAC } from "./helpers/wifi-hybrid-start.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

type Fixture = Awaited<ReturnType<typeof targetFixture>>;
type Perturb = (fixture: Fixture) => void;

function events(
	calls: readonly (readonly unknown[])[],
	event: string,
): object[] {
	return calls.flatMap(([, fields]) =>
		fields !== null &&
		typeof fields === "object" &&
		"event" in fields &&
		fields.event === event
			? [fields]
			: [],
	);
}

function refusalEventsWithUptime(
	calls: readonly (readonly unknown[])[],
): object[] {
	return events(calls, "wifi-hybrid-target-refused").map((fields) => {
		if (!("bootUptimeSeconds" in fields))
			throw new Error("Refusal has no boot uptime");
		if (!("path" in fields)) throw new Error("Refusal has no path");
		const { bootUptimeSeconds, path, ...originalFields } = fields;
		expect(bootUptimeSeconds).toEqual(expect.any(Number));
		expect(path).toBe("activation");
		return originalFields;
	});
}

function peerFlags(flags: string | undefined): void {
	const read = spyOn(radioIdentityReaders, "readText");
	const original = read.getMockImplementation();
	if (!original) throw new Error("Fixture reader is missing");
	read.mockImplementation(async (path) =>
		path.endsWith("/wlan9/flags") ? flags : original(path),
	);
}

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

function changeLeg(
	f: Fixture,
	fields: Partial<NonNullable<ReturnType<Fixture["objects"]["get"]>>>,
): void {
	const leg = f.objects.get("clap-wlan0");
	if (!leg) throw new Error("Fixture has no target");
	Object.assign(leg, fields);
}

function overrideIw(
	f: Fixture,
	transform: (args: string[], output: string) => string,
	visible = true,
): void {
	concurrent.setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			const output = await f.run(command, args);
			return command === "iw" ? transform(args, output) : output;
		},
		async () => visible,
	);
}

function atCreatedRevalidation(): () => boolean {
	const revalidate = creation.revalidateCreatedConcurrentApInterface;
	const currentTarget = records.currentTarget;
	let revalidating = false;
	let permitChecked = false;
	spyOn(records, "currentTarget").mockImplementation(async (...args) => {
		const current = await currentTarget(...args);
		if (revalidating) permitChecked = current;
		return current;
	});
	spyOn(creation, "revalidateCreatedConcurrentApInterface").mockImplementation(
		async (target, expected, observe) => {
			if (!observe) return revalidate(target, expected, observe);
			revalidating = true;
			try {
				return await revalidate(target, expected, observe);
			} finally {
				revalidating = false;
				permitChecked = false;
			}
		},
	);
	return () => permitChecked;
}

const refusals: ReadonlyArray<
	readonly [string, Perturb, { existing?: boolean; create?: boolean }?]
> = [
	["radio-unqualified", (f) => f.driver("mac80211_hwsim")],
	["boot-id-unavailable", (f) => f.boot(undefined)],
	["discovery-boot-mismatch", (f) => f.boot("different-boot")],
	["parent-sample-unavailable", (f) => f.objects.delete("wlan0")],
	["parent-identity-mismatch", (f) => f.permanent("02:00:00:00:00:11")],
	["creation-disabled", () => {}, { existing: false }],
	[
		"target-phy-mismatch",
		(f) => changeLeg(f, { phy: "/sys/devices/other/phy0" }),
	],
	["target-witness-mismatch", (f) => changeLeg(f, { ifindex: 99 })],
	[
		"retained-target-changed",
		() => {
			spyOn(records, "currentTarget").mockResolvedValue(false);
		},
	],
	[
		"p2p-not-idle",
		(f) => {
			f.state("20 (unavailable)");
			overrideIw(f, (args, text) =>
				args.length === 1
					? `${text}\nphy#0\n Unnamed/non-netdev interface\n type P2P-device`
					: text,
			);
		},
	],
	[
		"unnamed-phy-interface",
		(f) => {
			overrideIw(f, (args, text) =>
				args.length === 1
					? `${text}\nphy#0\n Unnamed/non-netdev interface\n type managed`
					: text,
			);
		},
	],
	[
		"parent-role-mismatch",
		(f) => {
			const parent = f.objects.get("wlan0");
			if (!parent) throw new Error("Fixture has no parent");
			parent.type = "AP";
		},
	],
	["target-role-mismatch", (f) => changeLeg(f, { type: "AP" })],
	[
		"peer-flags-unavailable",
		(f) => {
			overrideIw(f, (args, text) =>
				args.length === 1
					? `${text}\nphy#0\n Interface wlan9\n type managed`
					: text,
			);
			peerFlags(undefined);
		},
	],
	[
		"peer-interface-up",
		(f) => {
			overrideIw(f, (args, text) =>
				args.length === 1
					? `${text}\nphy#0\n Interface wlan9\n type managed`
					: text,
			);
			peerFlags("0x1");
		},
	],
	[
		"parent-not-in-iw",
		(f) => {
			overrideIw(f, (args, text) =>
				args.length === 1
					? text.replace(
							/phy#0\n Interface wlan0\n[^\n]+\n[^\n]+\n[^\n]+\n/,
							"",
						)
					: text,
			);
		},
	],
	[
		"target-iw-identity-mismatch",
		(f) => {
			overrideIw(f, (args, text) =>
				args.length === 1 ? text.replace("ifindex 7", "ifindex 99") : text,
			);
		},
	],
	["first-wireless-witness-mismatch", (f) => changeLeg(f, { wdev: "0x77" })],
	[
		"interface-combination-refused",
		(f) => f.combination("valid interface combinations:"),
	],
	["existing-target-not-idle", (f) => f.state("20 (unavailable)")],
	[
		"existing-target-has-stations",
		(f) => {
			overrideIw(f, (args, text) =>
				args.includes("station") ? "station present" : text,
			);
		},
	],
	["profile-ownership-unproven", (f) => f.readableProfiles(false)],
	["target-allocation-failed", (f) => overrideIw(f, (_, text) => text, false)],
	[
		"target-allocation-origin-mismatch",
		(f) => {
			const run = f.run;
			concurrent.setConcurrentInterfaceDepsForTest(
				async (command, args) => {
					if (args[1] === "clap-wlan0" && args.at(-1) === "info") {
						const parent = f.objects.get("wlan0");
						if (!parent) throw new Error("Fixture has no parent");
						f.objects.set("clap-wlan0", { ...parent, ifindex: 7, wdev: "0x7" });
					}
					return run(command, args);
				},
				async () => true,
			);
		},
		{ existing: false, create: true },
	],
	[
		"allocated-target-not-ready",
		(f) => {
			overrideIw(f, (args, text) => {
				if (args[1] === "clap-wlan0" && args.at(-1) === "info")
					f.state("20 (unavailable)");
				return text;
			});
		},
	],
	[
		"borrowed-target-changed",
		(f) => {
			f.reportTarget({ ifindex: 99 });
		},
	],
	[
		"created-target-changed",
		(f) => {
			const finalRead = atCreatedRevalidation();
			overrideIw(f, (args, text) =>
				args.join(" ") === "dev clap-wlan0 info" && finalRead()
					? text.replace("type managed", "type AP")
					: text,
			);
		},
		{ existing: false, create: true },
	],
	[
		"target-changed-before-policy",
		() => {
			spyOn(records, "currentTarget").mockResolvedValue(false);
		},
	],
	[
		"target-autoconnect-refused",
		() => {
			spyOn(records, "currentTarget")
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false);
		},
	],
	[
		"target-changed-after-policy",
		() => {
			spyOn(policy, "connectionsPermitAdoption")
				.mockResolvedValueOnce(true)
				.mockResolvedValueOnce(true)
				.mockResolvedValue(false);
		},
	],
];

for (const [reasonCode, perturb, options] of refusals) {
	test(`hybrid selector exposes ${reasonCode}`, async () => {
		const f = await targetFixture({ existing: options?.existing ?? true });
		if (reasonCode === "retained-target-changed")
			expect(
				await concurrent.selectConcurrentApInterface("wlan0"),
			).toBeDefined();
		perturb(f);
		const refused = mock((_refusal: { readonly reasonCode: string }) => {});
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				undefined,
				options?.create,
				refused,
			),
		).toBeUndefined();
		expect(refused.mock.calls).toHaveLength(1);
		expect(refused.mock.calls[0]?.[0]).toMatchObject({ reasonCode });
	});
}

test.each([
	[1, "admission-lost"],
	[2, "admission-lost-after-parent-sample"],
	[3, "admission-lost-after-combination"],
	[4, "admission-lost-after-profile-check"],
] as const)(
	"retired admission at check %i records %s before policy writes",
	async (rejectedAt, reasonCode) => {
		const f = await targetFixture();
		const refused = mock((_refusal: { readonly reasonCode: string }) => {});
		let checks = 0;
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				() => ++checks !== rejectedAt,
				true,
				refused,
			),
		).toBeUndefined();
		expect(refused.mock.calls).toEqual([
			[
				expect.objectContaining({
					reasonCode,
					qualified: rejectedAt === 1 ? null : true,
				}),
			],
		]);
		expect(f.autoconnect()).toBe("yes");
	},
);

test("first discovery adds no hybrid diagnostic on an unqualified radio", async () => {
	const info = spyOn(logger, "info").mockImplementation(() => logger);
	const f = await targetFixture({ recordDiscovery: false });
	f.driver("mac80211_hwsim");
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	expect(events(info.mock.calls, "wifi-hybrid-first-discovery")).toEqual([]);
});

for (const present of [true, false]) {
	test(`first discovery logs the target identity once (present=${present})`, async () => {
		const info = spyOn(logger, "info").mockImplementation(() => logger);
		const f = await targetFixture({
			existing: present,
			recordDiscovery: false,
		});
		for (let pass = 0; pass < 2; pass++)
			await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
				[...f.objects.keys()],
				wifiRadioIdentity.state.rows,
			);
		const seen = events(info.mock.calls, "wifi-hybrid-first-discovery");
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			parentIfname: "wlan0",
			targetIfname: "clap-wlan0",
			targetListed: present,
			permanentMac: present ? MAC : null,
			physicalPath: present ? f.objects.get("clap-wlan0")?.phy : null,
		});
	});
}

test("hybrid restore logs one warning with the selector's evidence and retry ordinal", async () => {
	const f = await hybridFixture();
	try {
		const warn = spyOn(logger, "warn").mockImplementation(() => logger);
		f.target.state("20 (unavailable)");
		const result = await startHotspotLocked(MAC, f.row, f.activationDeps, {
			restoreAttempt: { attempt: 2, maxAttempts: 3 },
		});
		expect(result).toMatchObject({
			success: false,
			reason: "hybrid-channel-not-permitted",
		});
		const seen = refusalEventsWithUptime(warn.mock.calls);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toEqual({
			event: "wifi-hybrid-target-refused",
			reasonCode: "existing-target-not-idle",
			parentIfname: "wlan0",
			targetIfname: "clap-wlan0",
			attempt: 2,
			maxAttempts: 3,
			processElapsedMs: expect.any(Number),
			targetListed: true,
			targetSampled: true,
			qualified: true,
			stationAssociated: true,
			samePermanentMac: true,
			samePhysicalPath: true,
			profileOwnership: null,
			targetNmState: 20,
			targetNmManaged: true,
			targetHasActiveConnection: false,
		});
		expect(f.effects).toEqual([]);
	} finally {
		await f.restore();
	}
});

test("boot discovery refusal warnings report the three actual restore attempts", async () => {
	const f = await hybridFixture();
	const config = getConfig();
	const original = config.wifi_modes;
	config.wifi_modes = { [MAC]: "hybrid" };
	f.target.state("20 (unavailable)");
	const warn = spyOn(logger, "warn").mockImplementation(() => logger);
	let published = false;
	const stop = startWifiAdapterModeRestore(
		{
			...defaultAdapterModeDeps,
			readCapabilities: f.activationDeps.readCapabilities,
			startHotspot: async (_device, publishOutcome, attempt) =>
				startHotspotLocked(
					MAC,
					f.row,
					{ ...f.activationDeps, publishOutcome },
					{ restoreAttempt: attempt },
				),
		},
		{
			hasDiscovery: () => published,
			subscribe: (listener) =>
				wifiAdapterModeRestoreSource.subscribe(() => {
					published = true;
					return listener();
				}),
		},
	);
	try {
		for (let discovery = 0; discovery < 4; discovery++)
			await notifyWifiAdapterModeDiscovery();
		expect(events(warn.mock.calls, "wifi-hybrid-target-refused")).toEqual(
			[1, 2, 3].map((attempt) =>
				expect.objectContaining({
					reasonCode: "existing-target-not-idle",
					attempt,
					maxAttempts: 3,
				}),
			),
		);
		expect(f.effects).toEqual([]);
	} finally {
		stop();
		if (original === undefined) delete config.wifi_modes;
		else config.wifi_modes = original;
		await f.restore();
	}
});

test("first discovery records the actual asynchronous iw witness beside the sysfs identity", async () => {
	const info = spyOn(logger, "info").mockImplementation(() => logger);
	spyOn(devices, "wifiDeviceListGetMacAddress").mockReturnValue(
		"02:00:00:00:00:07",
	);
	const f = await targetFixture({ recordDiscovery: false });
	const iw = Promise.withResolvers<string>();
	concurrent.setConcurrentInterfaceDepsForTest(
		(command, args) =>
			args.join(" ") === "dev clap-wlan0 info"
				? iw.promise
				: f.run(command, args),
		async () => true,
	);
	await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
		[...f.objects.keys()],
		wifiRadioIdentity.state.rows,
	);
	expect(events(info.mock.calls, "wifi-hybrid-first-discovery")).toEqual([]);
	iw.resolve(
		"Interface clap-wlan0\n ifindex 7\n wdev 0x7\n wiphy 0\n type managed\n",
	);
	await iw.promise;
	await Promise.resolve();
	expect(events(info.mock.calls, "wifi-hybrid-first-discovery")).toEqual([
		expect.objectContaining({
			operationalMac: "02:00:00:00:00:07",
			ifindex: 7,
			wiphy: 0,
			wdev: "0x7",
			bootId: "fixture-boot",
			processElapsedMs: expect.any(Number),
			bootUptimeSeconds: expect.any(Number),
		}),
	]);
});

function readRefusal() {
	return mock((_refusal: { readonly reasonCode: string }) => {});
}

test.each(["retained", "borrowed", "created"] as const)(
	"%s target revalidation logs the expected object and the actual wireless read",
	async (origin) => {
		const f = await targetFixture({ existing: origin !== "created" });
		if (origin === "retained")
			expect(
				await concurrent.selectConcurrentApInterface("wlan0"),
			).toBeDefined();
		const finalRead =
			origin === "created" ? atCreatedRevalidation() : undefined;
		overrideIw(f, (args, text) => {
			if (
				args.join(" ") === "dev clap-wlan0 info" &&
				(finalRead === undefined || finalRead())
			)
				return text.replace("wdev 0x7", "wdev 0x77");
			return text;
		});
		const refused = readRefusal();
		const result = await concurrent.selectConcurrentApInterface(
			"wlan0",
			undefined,
			true,
			refused,
		);
		expect(result).toBeUndefined();
		expect(refused.mock.calls[0]?.[0]).toMatchObject({
			reasonCode:
				origin === "retained"
					? "retained-target-changed"
					: origin === "borrowed"
						? "borrowed-target-changed"
						: "created-target-changed",
			witness: {
				name: "clap-wlan0",
				ifindex: 7,
				wiphy: 0,
				wdev: "0x7",
				phyPath: f.objects.get("wlan0")?.phy,
			},
			observed: {
				name: "clap-wlan0",
				ifindex: 7,
				wiphy: 0,
				wdev: "0x77",
				phyPath: f.objects.get("wlan0")?.phy,
			},
		});
	},
);

test.each(["changed", "never sampled"] as const)(
	"lifetime refusal distinguishes a witness %s",
	async (caseName) => {
		const f = await targetFixture({ recordDiscovery: false });
		const identities = new Map(wifiRadioIdentity.state.rows);
		if (caseName === "never sampled") identities.delete("clap-wlan0");
		await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
			[...f.objects.keys()],
			identities,
		);
		if (caseName === "changed") changeLeg(f, { ifindex: 90 });
		const refused = readRefusal();
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				undefined,
				true,
				refused,
			),
		).toBeUndefined();
		expect(refused.mock.calls[0]?.[0]).toMatchObject({
			reasonCode: "target-witness-mismatch",
			witness: {
				name: "clap-wlan0",
				ifindex: caseName === "changed" ? 7 : null,
				wiphy: caseName === "changed" ? 0 : null,
				phyPath:
					caseName === "changed" ? f.objects.get("clap-wlan0")?.phy : null,
				wdev: "0x7",
			},
			observed: {
				name: "clap-wlan0",
				ifindex: caseName === "changed" ? 90 : 7,
				wiphy: 0,
				phyPath: f.objects.get("clap-wlan0")?.phy,
				wdev: null,
				wirelessStatus: "not-read",
			},
		});
	},
);

test.each(["missing", "different", "unreadable witness"] as const)(
	"first wireless comparison reports %s",
	async (scenario) => {
		const f = await targetFixture({ recordDiscovery: false });
		if (scenario === "unreadable witness")
			overrideIw(f, (args, text) =>
				args.join(" ") === "dev clap-wlan0 info" ? "" : text,
			);
		await concurrent.observeConcurrentInterfacesAtFirstDiscovery(
			[...f.objects.keys()],
			wifiRadioIdentity.state.rows,
		);
		if (scenario === "missing")
			overrideIw(f, (args, text) =>
				args.length === 1
					? text.replace(
							/phy#0\n Interface clap-wlan0\n[^\n]+\n[^\n]+\n[^\n]+\n/,
							"",
						)
					: text,
			);
		if (scenario === "different") changeLeg(f, { wdev: "0x77" });
		const refused = readRefusal();
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				undefined,
				true,
				refused,
			),
		).toBeUndefined();
		expect(refused.mock.calls[0]?.[0]).toMatchObject({
			reasonCode:
				scenario === "missing"
					? "first-wireless-observation-unavailable"
					: "first-wireless-witness-mismatch",
			witness: {
				ifindex: 7,
				wdev: scenario === "unreadable witness" ? null : "0x7",
				wirelessStatus:
					scenario === "unreadable witness" ? "unavailable" : "observed",
			},
			observed: {
				ifindex: 7,
				wdev:
					scenario === "missing"
						? null
						: scenario === "different"
							? "0x77"
							: "0x7",
			},
		});
	},
);

test.each([
	["parent-identity-mismatch", "permanent-mac-mismatch"],
	["target-iw-identity-mismatch", "iw-ifindex-mismatch"],
	["target-allocation-failed", "borrowed-nm-not-visible"],
	["allocated-target-not-ready", "allocated-target-not-idle"],
] as const)(
	"%s includes the compound guard's failing condition",
	async (reasonCode, subReason) => {
		const f = await targetFixture();
		const fixtureCase = refusals.find(([code]) => code === reasonCode);
		if (!fixtureCase) throw new Error("Missing diagnostic fixture");
		fixtureCase[1](f);
		const refused = readRefusal();
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				undefined,
				true,
				refused,
			),
		).toBeUndefined();
		expect(refused.mock.calls[0]?.[0]).toMatchObject({ reasonCode, subReason });
	},
);

function newJournalEvents(offset: number): unknown[] {
	return getRecentLogLines()
		.slice(offset)
		.flatMap((line) => {
			const entry = JSON.parse(line);
			return entry.meta?.event === "wifi-hybrid-target-refused"
				? [entry.meta]
				: [];
		});
}

test.each([
	["not-associated", null, false, null],
	["dfs-or-no-ir", "5", true, false],
	["unqualified-band", "5", true, true],
] as const)(
	"preselector station rejection records %s and stays before allocation",
	async (subReason, frequencyBand, stationAssociated, channelPermitted) => {
		const f = await hybridFixture();
		try {
			if (subReason === "not-associated")
				overrideIw(f.target, (args, text) =>
					args.at(-1) === "link" ? "Not connected." : text,
				);
			else {
				f.target.frequency(5180, "", 36);
				f.target.reg(
					`global\ncountry US: DFS-FCC\n (5150 - 5250 @ 80), (N/A, 20), (N/A)${subReason === "dfs-or-no-ir" ? ", NO-IR" : ""}`,
				);
			}
			const offset = getRecentLogLines().length;
			expect(
				await startHotspotLocked(MAC, f.row, f.activationDeps, {
					restoreAttempt: { attempt: 2, maxAttempts: 3 },
				}),
			).toMatchObject({
				success: false,
				reason: "hybrid-channel-not-permitted",
			});
			expect(newJournalEvents(offset)).toEqual([
				expect.objectContaining({
					reasonCode: "station-channel-unavailable",
					path: "activation",
					subReason,
					frequencyBand,
					stationAssociated,
					channelPermitted,
					attempt: 2,
					maxAttempts: 3,
					processElapsedMs: expect.any(Number),
					bootUptimeSeconds: expect.any(Number),
				}),
			]);
			expect(f.effects).toEqual([]);
		} finally {
			await f.restore();
		}
	},
);

test("operator Start reports an uninstrumented allocator refusal with null retry coordinates", async () => {
	const f = await hybridFixture();
	try {
		const offset = getRecentLogLines().length;
		await startHotspotLocked(MAC, f.row, {
			...f.activationDeps,
			ensureConcurrentInterface: async () => undefined,
		});
		expect(newJournalEvents(offset)).toEqual([
			expect.objectContaining({
				reasonCode: "target-allocation-unreported",
				path: "operator-start",
				attempt: null,
				maxAttempts: null,
				bootUptimeSeconds: expect.any(Number),
			}),
		]);
	} finally {
		await f.restore();
	}
});

test("operator preselector rejection carries its own diagnostic path", async () => {
	const f = await hybridFixture();
	try {
		overrideIw(f.target, (args, text) =>
			args.at(-1) === "link" ? "Not connected." : text,
		);
		const offset = getRecentLogLines().length;
		await startHotspotLocked(MAC, f.row, f.activationDeps);
		expect(newJournalEvents(offset)).toEqual([
			expect.objectContaining({
				reasonCode: "station-channel-unavailable",
				path: "operator-start",
				attempt: null,
			}),
		]);
	} finally {
		await f.restore();
	}
});
