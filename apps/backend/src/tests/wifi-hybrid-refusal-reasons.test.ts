import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as concurrent from "../modules/wifi/wifi-concurrent-interface.ts";
import * as creation from "../modules/wifi/wifi-concurrent-interface-creation.ts";
import type {
	AllocationFailure,
	HybridChannelSubReason,
	HybridTargetRefusal,
	SelectorSubReason,
} from "../modules/wifi/wifi-hybrid-target-diagnostics.ts";
import { selectedTargets } from "../modules/wifi/wifi-hybrid-target-record.ts";
import { wifiRadioIdentity } from "../modules/wifi/wifi-radio-identity.ts";
import { targetFixture } from "./helpers/wifi-hybrid-target.ts";

type Fixture = Awaited<ReturnType<typeof targetFixture>>;
type Runner = Fixture["run"];

afterEach(() => {
	concurrent.resetConcurrentInterfaceDepsForTest();
	mock.restore();
});

type AllocationCase = {
	borrowed?: boolean;
	admission?: number;
	visible?: boolean;
	badIdentityRead?: number;
	failIdentityQuery?: boolean;
	add?: "throw" | "no-receipt";
	policy?: "deny" | "throw" | "autoconnect-unavailable";
	creationForbidden?: boolean;
	ap?: boolean;
};

const allocationCases = {
	"admission-lost-before-lookup": { admission: 1 },
	"admission-lost-after-lookup": { admission: 2 },
	"borrowed-role-not-managed": { borrowed: true, ap: true },
	"admission-lost-after-borrowed-wait": { borrowed: true, admission: 3 },
	"borrowed-nm-not-visible": { borrowed: true, visible: false },
	"create-forbidden": { creationForbidden: true },
	"create-command-failed": { add: "throw" },
	"creation-receipt-unavailable": { add: "no-receipt" },
	"admission-lost-after-create": { admission: 3 },
	"created-identity-query-failed": {
		badIdentityRead: 1,
		failIdentityQuery: true,
	},
	"created-identity-mismatch": { badIdentityRead: 1 },
	"admission-lost-after-created-wait": { admission: 4 },
	"created-nm-not-visible": { visible: false },
	"created-identity-changed-after-wait": { badIdentityRead: 2 },
	"creation-permit-refused": { policy: "deny" },
	"created-autoconnect-refused": { policy: "autoconnect-unavailable" },
	"admission-lost-after-created-autoconnect": { admission: 5 },
	"allocation-read-or-write-failed": { policy: "throw" },
} satisfies Record<AllocationFailure, AllocationCase>;

test.each(Object.entries<AllocationCase>(allocationCases))(
	"allocator reports %s and returns no target",
	async (subReason, fixture) => {
		const f = await targetFixture({
			existing: fixture.borrowed ?? false,
			recordDiscovery: false,
		});
		const leg = f.objects.get("clap-wlan0");
		if (fixture.ap && leg) leg.type = "AP";
		let admissionChecks = 0;
		let identityReads = 0;
		concurrent.setConcurrentInterfaceDepsForTest(
			async (command, args) => {
				if (fixture.add === "throw" && args.includes("add"))
					throw new Error("fixture add failure");
				const result = await f.run(command, args);
				if (fixture.add === "no-receipt" && args.includes("add")) return "";
				if (
					command === "iw" &&
					args.join(" ") === "dev clap-wlan0 info" &&
					++identityReads === fixture.badIdentityRead
				) {
					if (fixture.failIdentityQuery)
						throw Object.assign(new Error("fixture iw query failed"), {
							code: 1,
						});
					return "";
				}
				return result;
			},
			async () => fixture.visible ?? true,
		);
		const permit = async () => {
			if (fixture.policy === "throw")
				throw new Error("fixture profile read failure");
			if (fixture.policy === "autoconnect-unavailable")
				f.externalAutoconnect("");
			return fixture.policy !== "deny";
		};
		const reasons: string[] = [];
		expect(
			await creation.ensureConcurrentApInterface(
				"wlan0",
				() => ++admissionChecks !== fixture.admission,
				fixture.creationForbidden ? false : permit,
				(reason) => reasons.push(reason),
			),
		).toBeUndefined();
		expect(reasons).toEqual([subReason]);
	},
);

function alterRead(
	f: Fixture,
	transform: (args: string[], value: string) => string,
): void {
	const run: Runner = async (command, args) =>
		transform(args, await f.run(command, args));
	concurrent.setConcurrentInterfaceDepsForTest(run, async () => true);
}

function replaceParent(f: Fixture): void {
	const row = f.objects.get("wlan0");
	if (!row) throw new Error("Missing parent fixture");
	row.ifindex++;
}

function useFiveGhz(f: Fixture): void {
	f.frequency(5180, "", 36);
	f.reg("global\ncountry US: DFS-FCC\n (5150 - 5250 @ 80), (N/A, 20), (N/A)");
}

const channelCases = {
	"parent-sample-unavailable": (f) => {
		f.objects.delete("wlan0");
	},
	"parent-identity-mismatch": replaceParent,
	"not-associated": (f) =>
		alterRead(f, (args, value) =>
			args.at(-1) === "link" ? "Not connected." : value,
		),
	"station-connection-unavailable": (f) => f.station("--"),
	"station-link-mismatch": (f) => f.reportParentIndex(99),
	"interface-combination-refused": (f) =>
		f.combination("valid interface combinations:"),
	"regulatory-evidence-unavailable": (f) => f.reg(""),
	"no-permitting-regulatory-rule": (f) =>
		f.reg("global\ncountry US: DFS-FCC\n (5150 - 5250 @ 80), (N/A, 20), (N/A)"),
	"dfs-or-no-ir": (f) =>
		f.reg(
			"global\ncountry US: DFS-FCC\n (2400 - 2480 @ 40), (N/A, 20), (N/A), NO-IR",
		),
	"ap-channel-unavailable": (f) => {
		useFiveGhz(f);
		alterRead(f, (args, value) =>
			args[0] === "phy"
				? value.replace("(20.0 dBm)", "(20.0 dBm) (radar detection)")
				: value,
		);
	},
	"unqualified-band": useFiveGhz,
	unclassified: () => {
		spyOn(fs, "realpathSync").mockImplementation(
			Object.assign(
				() => {
					throw new Error("fixture driver lookup failed");
				},
				{ native: fs.realpathSync.native },
			),
		);
	},
	"radio-unqualified": (f) => {
		useFiveGhz(f);
		f.driver("mac80211_hwsim");
	},
	"station-identity-changed": (f) =>
		alterRead(f, (args, value) => {
			if (args[0] === "reg") replaceParent(f);
			return value;
		}),
	"channel-read-failed": (f) =>
		alterRead(f, (args, value) => {
			if (args.at(-1) === "link") throw new Error("fixture link read failed");
			return value;
		}),
} satisfies Record<HybridChannelSubReason, (f: Fixture) => void>;

test.each(Object.entries(channelCases))(
	"station reader reports %s",
	async (subReason, arrange) => {
		const f = await targetFixture();
		arrange(f);
		const refusals: string[] = [];
		expect(
			await concurrent.readHybridStationChannel("wlan0", (evidence) =>
				refusals.push(evidence.subReason),
			),
		).toBeUndefined();
		expect(refusals).toEqual([subReason]);
	},
);

type SelectorCase = readonly [
	HybridTargetRefusal["reasonCode"],
	(f: Fixture) => void | Promise<void>,
];

function forceReplacement(f: Fixture, fields: { ifindex: number }): void {
	const leg = f.objects.get("clap-wlan0");
	if (!leg) throw new Error("Missing target fixture");
	Object.assign(leg, fields);
}

const selectorCases = {
	"parent-lifetime-unavailable": [
		"parent-identity-mismatch",
		async () => {
			await wifiRadioIdentity.discover([]);
		},
	],
	"parent-lifetime-mismatch": ["parent-identity-mismatch", replaceParent],
	"permanent-mac-mismatch": [
		"parent-identity-mismatch",
		(f) => f.permanent("02:00:00:00:00:09"),
	],
	"stored-boot-mismatch": [
		"target-witness-mismatch",
		() => {
			const witness = selectedTargets.get("clap-wlan0");
			if (!witness) throw new Error("Missing discovery witness");
			selectedTargets.set("clap-wlan0", { ...witness, boot: "older-boot" });
		},
	],
	"live-target-unavailable": [
		"target-witness-mismatch",
		(f) => {
			f.objects.delete("clap-wlan0");
		},
	],
	"stored-lifetime-mismatch": [
		"target-witness-mismatch",
		(f) => forceReplacement(f, { ifindex: 9 }),
	],
	"target-missing-in-iw": [
		"first-wireless-observation-unavailable",
		(f) =>
			alterRead(f, (args, value) =>
				args.length === 1
					? value.replace(
							/phy#0\n Interface clap-wlan0\n[^\n]+\n[^\n]+\n[^\n]+\n/,
							"",
						)
					: value,
			),
	],
	"iw-ifindex-mismatch": [
		"target-iw-identity-mismatch",
		(f) =>
			alterRead(f, (args, value) =>
				args.length === 1 ? value.replace("ifindex 7", "ifindex 9") : value,
			),
	],
	"iw-wdev-unavailable": [
		"target-iw-identity-mismatch",
		(f) =>
			alterRead(f, (args, value) =>
				args.length === 1
					? value.replace("wdev 0x7", "wdev unreadable")
					: value,
			),
	],
	"target-sample-unavailable": [
		"allocated-target-not-ready",
		(f) => {
			let reads = 0;
			alterRead(f, (args, value) => {
				if (args.join(" ") === "dev clap-wlan0 info" && ++reads === 1)
					f.readableTarget(false);
				return value;
			});
		},
	],
	"target-wireless-identity-unavailable": [
		"allocated-target-not-ready",
		(f) => {
			let reads = 0;
			alterRead(f, (args, value) =>
				args.join(" ") === "dev clap-wlan0 info" && ++reads === 2
					? value.replace("wdev 0x7", "wdev unreadable")
					: value,
			);
		},
	],
	"target-autoconnect-unavailable": [
		"allocated-target-not-ready",
		(f) => f.externalAutoconnect(""),
	],
	"allocated-target-not-idle": [
		"allocated-target-not-ready",
		(f) =>
			alterRead(f, (args, value) => {
				if (args.join(" ") === "dev clap-wlan0 info")
					f.state("20 (unavailable)");
				return value;
			}),
	],
	"allocator-unreported": [
		"target-allocation-failed",
		() => {
			spyOn(creation, "ensureConcurrentApInterface").mockResolvedValue(
				undefined,
			);
		},
	],
} satisfies Record<SelectorSubReason, SelectorCase>;

test.each(Object.entries<SelectorCase>(selectorCases))(
	"selector reports %s on its original refusal exit",
	async (subReason, [reasonCode, arrange]) => {
		const f = await targetFixture();
		await arrange(f);
		const refusals: HybridTargetRefusal[] = [];
		expect(
			await concurrent.selectConcurrentApInterface(
				"wlan0",
				undefined,
				true,
				(refusal) => refusals.push(refusal),
			),
		).toBeUndefined();
		expect(refusals).toEqual([
			expect.objectContaining({ reasonCode, subReason }),
		]);
	},
);
