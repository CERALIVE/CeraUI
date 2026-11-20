import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as nm from "../modules/network/network-manager.ts";
import * as secrets from "../modules/network/network-manager-secret.ts";
import { setConcurrentInterfaceDepsForTest } from "../modules/wifi/wifi-concurrent-interface-io.ts";
import {
	defaultHotspotConfigDeps,
	reconfigureHotspotForRegdomain,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import {
	resetConcurrentInterfaceDepsForTest,
	selectedTargets,
	targetRecords,
} from "../modules/wifi/wifi-hybrid-target-record.ts";
import {
	radioIdentityReaders,
	wifiRadioIdentity,
} from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { qualifiedHybridEvidence } from "./helpers/wifi-hybrid-qualification.ts";

const serialize = secrets.serializeNmProfileModify;
const deviceProp = nm.nmDeviceProp;
const phyPath = "/sys/devices/equivalence/phy1";
const LEG = "clap-wlan0";

async function hybrid() {
	const f = await firstAp(undefined, true);
	let legIndex = "21";
	let legUnreadable = false;
	let onParentRead: (() => void) | undefined;
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path === "/sys/class/net/wlan0/ifindex") {
			const observe = onParentRead;
			onParentRead = undefined;
			observe?.();
			return "10";
		}
		if (path.endsWith("/ifindex")) {
			if (!legUnreadable) return legIndex;
			legUnreadable = false;
			return undefined;
		}
		return path.endsWith("/index") ? "1" : MAC;
	});
	spyOn(radioIdentityReaders, "realpath").mockResolvedValue(phyPath);
	const replaceLeg = () => {
		legIndex = "22";
	};
	return {
		...f,
		leg: () => legIndex,
		replaceLeg,
		replaceLegDuringNextParentRead: () => {
			onParentRead = replaceLeg;
		},
		replaceLegAfterStagedSecret: () => {
			spyOn(secrets, "serializeNmProfileModify").mockImplementation(
				async (before, fields) => {
					const output = await serialize(before, fields);
					if (fields["802-11-wireless-security.psk"] !== undefined)
						onParentRead = replaceLeg;
					return output;
				},
			);
		},
		loseNextLegSample: () => {
			legUnreadable = true;
		},
		afterSavedStart: async () => {
			const first = await f.start();
			const uuid = f.created();
			if (!first.success || !uuid)
				throw new Error("Missing saved hybrid profile");
			settlePending(f.row.ifname, true);
			f.observe(undefined, "ap");
			delete f.row.concurrentHotspot;
			return uuid;
		},
	};
}

const loads = (commands: readonly string[][]) =>
	commands.filter(
		([object, action]) => object === "connection" && action === "load",
	);

test("a saved hybrid Start does not pin after its leg changes during the last parent sample", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		// A drifted priority makes the pin a real NetworkManager write.
		const saved = f.settings.get(uuid);
		if (!saved) throw new Error("Missing saved settings");
		saved["connection.autoconnect-priority"] = "0";
		f.nm.files.write(uuid);
		const beginning = f.commands.length;
		f.deps.validateConcurrentInterface = async () => {
			f.replaceLegDuringNextParentRead();
			return true;
		};
		const result = await f.start();
		expect(
			f.commands
				.slice(beginning)
				.filter(([object, action]) => object === "con" && action === "modify"),
		).toEqual([]);
		expect(f.active()).toBeUndefined();
		expect(result).toEqual({ success: false, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});

test.each(["inactive-add", "staged-secret"] as const)(
	"a first hybrid Start loads no credential after a leg replacement at %s",
	async (edge) => {
		const f = await hybrid();
		try {
			if (edge === "inactive-add")
				f.faults.afterAdd = async () => f.replaceLeg();
			else f.replaceLegAfterStagedSecret();
			const result = await f.start();
			expect(f.created()).toBeDefined();
			expect(loads(f.commands)).toEqual([]);
			expect(f.active()).toBeUndefined();
			expect(result).toMatchObject({ success: false, error: "radio-changed" });
		} finally {
			await f.restore();
		}
	},
);

test("a first hybrid Start stops its AP when the leg is replaced after Up", async () => {
	const f = await hybrid();
	try {
		const connect = f.deps.nmConnect;
		f.deps.nmConnect = async (...args) => {
			const up = await connect(...args);
			f.replaceLeg();
			return up;
		};
		const result = await f.start();
		expect(
			f.commands.some((args) => args[2] === "conn" && args[3] === "up"),
		).toBeTrue();
		expect(f.active()).toBeUndefined();
		expect(result).toMatchObject({ success: false, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});

test("hybrid Configure does not publish a staged keyfile after its leg changes", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		// A renamed hotspot makes the shared writer stage a real credential write.
		f.row.hotspot.name = "Renamed AP";
		const filename = f.nm.files.filename(uuid);
		const original = await readFile(filename);
		const beginning = f.commands.length;
		f.replaceLegAfterStagedSecret();
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...defaultHotspotConfigDeps,
			...qualifiedHybridEvidence,
			readHybridTargetIdentity: async () => f.leg(),
			getCapabilities: () => undefined,
			broadcastState: f.deps.broadcastState,
			wifiUpdateSavedConns: f.deps.wifiUpdateSavedConns,
		});
		expect(await readFile(filename)).toEqual(original);
		expect(loads(f.commands.slice(beginning))).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test("a saved hybrid Start restores its borrowed leg's autoconnect after its stale AP is down", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		const parent = wifiRadioIdentity.state.rows.get("wlan0")?.incarnation;
		if (!parent) throw new Error("Missing parent incarnation");
		const target = { ifname: LEG, created: false };
		const record = {
			boot: "boot-test",
			parent: { ifindex: 10, wiphy: 1, phyPath },
			target: { ifindex: 21, wiphy: 1, phyPath },
			wireless: { ifindex: "21", wdev: "0x15" },
			parentIfname: "wlan0",
			parentIncarnation: parent,
			priorAutoconnect: "yes",
		};
		targetRecords.set(target, record);
		selectedTargets.set(LEG, {
			boot: "boot-test",
			first: record.target,
			record,
		});
		// This Start borrowed the leg and suppressed its device autoconnect.
		let autoconnect = "no";
		setConcurrentInterfaceDepsForTest(
			async (command, args) => {
				if (command === "iw")
					return `Interface ${LEG}\n\tifindex 21\n\twdev 0x15\n\twiphy 1\n\ttype managed\n`;
				if (args.slice(0, 4).join(" ") === `device set ${LEG} autoconnect`) {
					autoconnect = args[4] ?? autoconnect;
					return "";
				}
				throw new Error("Unexpected interface command");
			},
			null,
			async () => "boot-test\n",
		);
		spyOn(nm, "nmDeviceProp").mockImplementation(async (ifname, fields) => {
			if (ifname !== LEG) return deviceProp(ifname, fields);
			if (fields === "GENERAL.AUTOCONNECT") return [autoconnect];
			if (fields === "GENERAL.STATE,GENERAL.NM-MANAGED,GENERAL.CON-UUID")
				return f.active() === uuid
					? ["100 (connected)", "yes", uuid]
					: ["30 (disconnected)", "yes", ""];
			return deviceProp(ifname, fields);
		});
		f.deps.ensureConcurrentInterface = async () => target;
		const releaseLeg = f.deps.releaseConcurrentInterface;
		let release: Promise<void> | undefined;
		f.deps.releaseConcurrentInterface = (...args) => {
			release = releaseLeg?.(...args);
			return release ?? Promise.resolve();
		};
		const down = f.deps.nmDisconnect;
		// NetworkManager completes this Down after any release already checking the leg.
		f.deps.nmDisconnect = async (id) => {
			await release;
			return down(id);
		};
		const connect = f.deps.nmConnect;
		f.deps.nmConnect = async (...args) => {
			const up = await connect(...args);
			f.loseNextLegSample();
			return up;
		};
		const result = await f.start();
		expect(f.active()).toBeUndefined();
		expect(autoconnect).toBe("yes");
		expect(result).toEqual({ success: false, error: "radio-changed" });
	} finally {
		resetConcurrentInterfaceDepsForTest();
		await f.restore();
	}
});
