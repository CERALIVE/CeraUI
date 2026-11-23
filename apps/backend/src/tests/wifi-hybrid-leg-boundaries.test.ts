import { expect, spyOn, test } from "bun:test";
import { readFile } from "node:fs/promises";
import * as retries from "../helpers/retry.ts";
import * as nm from "../modules/network/network-manager.ts";
import * as profiles from "../modules/network/network-manager-profile-instance.ts";
import * as secrets from "../modules/network/network-manager-secret.ts";
import {
	wifiAdapterLockKey,
	withWifiAdapterLock,
} from "../modules/wifi/wifi-adapter-lock.ts";
import { resolveWifiAdapterOwner } from "../modules/wifi/wifi-adapter-owner.ts";
import {
	cancelWifiAdapterReconciliation,
	reconcileWifiAdapterTeardownLocked,
} from "../modules/wifi/wifi-adapter-reconcile-retry.ts";
import { setConcurrentInterfaceDepsForTest } from "../modules/wifi/wifi-concurrent-interface-io.ts";
import {
	defaultHotspotConfigDeps,
	reconfigureHotspotForRegdomain,
} from "../modules/wifi/wifi-hotspot-config.ts";
import {
	handleWifiMonitorEvent,
	settlePending,
} from "../modules/wifi/wifi-hotspot-monitor.ts";
import { HOTSPOT_UP_TO } from "../modules/wifi/wifi-hotspot-types.ts";
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
	let legMisreads = 0;
	let onParentRead: (() => void) | undefined;
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (path === "/sys/class/net/wlan0/ifindex") {
			const observe = onParentRead;
			onParentRead = undefined;
			observe?.();
			return "10";
		}
		if (path.endsWith("/ifindex")) {
			if (legMisreads > 0) {
				legMisreads--;
				return "22";
			}
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
		// One whole sample (both ifindex reads) reports a different leg, then the original returns.
		misreadNextLegSample: () => {
			legMisreads = 2;
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
		let release: Promise<boolean> | undefined;
		f.deps.releaseConcurrentInterface = (...args) =>
			(release = releaseLeg(...args));
		const down = f.deps.nmDisconnect;
		// NetworkManager completes this Down after any release already checking the leg.
		f.deps.nmDisconnect = async (...args) => {
			await release;
			return down(...args);
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

type HybridFixture = Awaited<ReturnType<typeof hybrid>>;

const configDeps = (f: HybridFixture) => ({
	...defaultHotspotConfigDeps,
	...qualifiedHybridEvidence,
	readHybridTargetIdentity: async () => f.leg(),
	getCapabilities: () => undefined,
	broadcastState: f.deps.broadcastState,
	wifiUpdateSavedConns: f.deps.wifiUpdateSavedConns,
});

const startFrames = (frames: readonly string[]) =>
	frames.flatMap((raw) => {
		const start = JSON.parse(raw).wifi?.hotspot?.start;
		return start ? [start] : [];
	});

/** The next Start borrows the leg with its device autoconnect suppressed from `yes`. */
async function borrowLeg(f: HybridFixture) {
	spyOn(radioIdentityReaders, "listInterfaces").mockResolvedValue([
		"wlan0",
		LEG,
	]);
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
	selectedTargets.set(LEG, { boot: "boot-test", first: record.target, record });
	let autoconnect = "no";
	const writes: string[] = [];
	setConcurrentInterfaceDepsForTest(
		async (command, args) => {
			if (command === "iw")
				return `Interface ${LEG}\n\tifindex 21\n\twdev 0x15\n\twiphy 1\n\ttype managed\n`;
			if (args.slice(0, 4).join(" ") === `device set ${LEG} autoconnect`) {
				autoconnect = args[4] ?? autoconnect;
				writes.push(autoconnect);
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
			return f.active()
				? ["100 (connected)", "yes", f.active() ?? ""]
				: ["30 (disconnected)", "yes", ""];
		return deviceProp(ifname, fields);
	});
	f.deps.ensureConcurrentInterface = async () => target;
	return {
		autoconnect: () => autoconnect,
		writes,
		succeed: () =>
			selectedTargets.set(LEG, {
				boot: "boot-test",
				first: record.target,
				record: { ...record, priorAutoconnect: "no" },
			}),
	};
}

test("a saved hybrid Start does not repair credentials after its leg changes during staging", async () => {
	const f = await hybrid();
	try {
		await f.afterSavedStart();
		delete f.row.hotspot.password;
		// The remembered password differs from the profile, so the repair is a real write.
		f.deps.credentials = {
			...f.deps.credentials,
			get: () => ({ ssid: "First AP", password: "remembered-test-password" }),
		};
		const beginning = f.commands.length;
		f.replaceLegAfterStagedSecret();
		const result = await f.start();
		expect(loads(f.commands.slice(beginning))).toEqual([]);
		expect(result).toEqual({ success: false, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});

test("deferred release retains and restores a borrowed leg's policy across parent unavailability", async () => {
	const f = await hybrid();
	try {
		const leg = await borrowLeg(f);
		const terminal = Promise.withResolvers<unknown>();
		const expire = Promise.withResolvers<void>();
		f.deps.pollHotspotActive = async () => false;
		f.deps.publishOutcome = (_kind, _device, outcome) =>
			terminal.resolve(outcome);
		const retry = retries.retryWithBackoff;
		spyOn(retries, "retryWithBackoff").mockImplementation(
			async (action, options) => {
				if (options?.baseDelayMs !== 500) return retry(action, options);
				await expire.promise;
				return action();
			},
		);
		expect(await f.start()).toEqual({ success: true });
		const prior = wifiRadioIdentity.state.rows.get(f.row.ifname)?.incarnation;
		wifiRadioIdentity.markUnavailable(f.row.ifname);
		expect(
			wifiRadioIdentity.state.rows.get(f.row.ifname)?.incarnation,
		).not.toBe(prior);
		expire.resolve();
		await terminal.promise;

		expect(selectedTargets.get(LEG)?.record?.priorAutoconnect).toBe("yes");
		expect(leg.writes).toEqual([]);
		f.observe(undefined, "ap");
		const owner = resolveWifiAdapterOwner(MAC, f.row);
		await withWifiAdapterLock(wifiAdapterLockKey(owner), () =>
			reconcileWifiAdapterTeardownLocked(owner),
		);
		expect(leg.autoconnect()).toBe("yes");
		expect(leg.writes).toEqual(["yes"]);
	} finally {
		cancelWifiAdapterReconciliation();
		resetConcurrentInterfaceDepsForTest();
		await f.restore();
	}
});

test("deferred hybrid confirmation refuses when the leg changes during the parent sample", async () => {
	const f = await hybrid();
	try {
		expect((await f.start()).success).toBeTrue();
		const beginning = f.frames.length;
		f.replaceLegDuringNextParentRead();
		await handleWifiMonitorEvent({
			type: "device-state",
			device: LEG,
			state: "connected",
		});
		expect(startFrames(f.frames.slice(beginning))).toEqual([
			{ device: 0, error: "radio-changed" },
		]);
		expect(f.active()).toBeUndefined();
	} finally {
		await f.restore();
	}
});

test("hybrid Configure dispatches no restart Up after its leg changes during the parent sample", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const beginning = f.commands.length;
		let channelReads = 0;
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...configDeps(f),
			readHybridChannel: async (ifname) => {
				channelReads += 1;
				if (channelReads > 1) f.replaceLegDuringNextParentRead();
				return qualifiedHybridEvidence.readHybridChannel(ifname);
			},
		});
		expect(
			f.commands
				.slice(beginning)
				.filter((args) => args[2] === "conn" && args[3] === "up"),
		).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test("hybrid Configure does not commit credentials after its leg changes during the saved-profile refresh", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const remembered: unknown[] = [];
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...configDeps(f),
			rememberCredentials: (...args) => {
				remembered.push(args);
			},
			wifiUpdateSavedConns: async () => {
				await f.deps.wifiUpdateSavedConns();
				f.replaceLeg();
			},
		});
		expect(remembered).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});

test.each(["original", "successor"] as const)(
	"deferred hybrid rollback after its Down leaves the leg's autoconnect to the %s selection",
	async (selection) => {
		const f = await hybrid();
		try {
			const leg = await borrowLeg(f);
			expect((await f.start()).success).toBeTrue();
			if (selection === "successor") {
				const down = f.deps.nmDisconnect;
				f.deps.nmDisconnect = async (...args) => {
					leg.succeed();
					return down(...args);
				};
			}
			const beginning = f.frames.length;
			f.misreadNextLegSample();
			await handleWifiMonitorEvent({
				type: "device-state",
				device: LEG,
				state: "connected",
			});
			expect(startFrames(f.frames.slice(beginning))).toEqual([
				{ device: 0, error: "radio-changed" },
			]);
			expect(f.active()).toBeUndefined();
			expect(leg.writes).toEqual(selection === "original" ? ["yes"] : []);
		} finally {
			resetConcurrentInterfaceDepsForTest();
			await f.restore();
		}
	},
);

test("a retried hybrid cleanup restores the borrowed leg's autoconnect after its Down", async () => {
	const f = await hybrid();
	try {
		const leg = await borrowLeg(f);
		const connect = f.deps.nmConnect;
		f.deps.nmConnect = async (...args) => {
			const up = await connect(...args);
			f.misreadNextLegSample();
			f.faults.downFails = true;
			f.faults.deleteFails = true;
			return up;
		};
		expect(await f.start()).toMatchObject({
			success: false,
			error: "radio-changed",
			reason: "cleanup-pending",
		});
		expect(leg.autoconnect()).toBe("no");
		f.faults.downFails = false;
		f.faults.deleteFails = false;
		const owner = resolveWifiAdapterOwner(MAC, f.row);
		const retry = await withWifiAdapterLock(wifiAdapterLockKey(owner), () =>
			reconcileWifiAdapterTeardownLocked(owner),
		);
		expect(retry).toMatchObject({ success: true, result: { complete: true } });
		expect(f.active()).toBeUndefined();
		expect(leg.autoconnect()).toBe("yes");
	} finally {
		resetConcurrentInterfaceDepsForTest();
		await f.restore();
	}
});

test("a saved hybrid Start rollback leaves a successor activation of its profile up", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		const connect = f.deps.nmConnect;
		f.deps.nmConnect = async (...args) => {
			const up = await connect(...args);
			f.misreadNextLegSample();
			return up;
		};
		const down = f.deps.nmDisconnect;
		f.deps.nmDisconnect = async (...args) => {
			// The original activation ends and the same profile is activated again before Down.
			await connect(uuid, HOTSPOT_UP_TO);
			return down(...args);
		};
		const result = await f.start();
		expect(f.active()).toBe(uuid);
		expect(result).toEqual({
			success: false,
			error: "radio-changed",
			reason: "deactivation-failed",
		});
	} finally {
		await f.restore();
	}
});

test("deferred hybrid rollback leaves a successor activation of its profile up", async () => {
	const f = await hybrid();
	try {
		expect((await f.start()).success).toBeTrue();
		const uuid = f.created();
		const connect = f.deps.nmConnect;
		const down = f.deps.nmDisconnect;
		f.deps.nmDisconnect = async (...args) => {
			if (uuid) await connect(uuid, HOTSPOT_UP_TO);
			return down(...args);
		};
		const beginning = f.frames.length;
		f.misreadNextLegSample();
		await handleWifiMonitorEvent({
			type: "device-state",
			device: LEG,
			state: "connected",
		});
		expect(f.active()).toBe(uuid);
		expect(startFrames(f.frames.slice(beginning))).toEqual([
			{ device: 0, error: "radio-changed", reason: "deactivation-failed" },
		]);
	} finally {
		await f.restore();
	}
});

test("a first hybrid Start whose leg is replaced while NetworkManager loads its keyfile dispatches no Up", async () => {
	const f = await hybrid();
	try {
		f.faults.afterSecretWrite = async () => f.replaceLeg();
		const result = await f.start();
		const uuid = f.created();
		// Residual limit: the load itself already ran; the next effect's proof refuses.
		expect(loads(f.commands)).toHaveLength(1);
		expect(
			f.commands.some((args) => args[2] === "conn" && args[3] === "up"),
		).toBeFalse();
		expect(uuid).toBeDefined();
		expect(f.profiles.has(uuid ?? "")).toBeFalse();
		expect(f.active()).toBeUndefined();
		expect(result).toMatchObject({ success: false, error: "radio-changed" });
	} finally {
		await f.restore();
	}
});

test.each(["idle", "busy", "down-reply-lost"] as const)(
	"a deferred hybrid refusal restores its borrowed leg when it becomes idle (%s)",
	async (schedule) => {
		const f = await hybrid();
		try {
			const leg = await borrowLeg(f);
			const terminal = Promise.withResolvers<unknown>();
			f.deps.publishOutcome = (_kind, _device, outcome) =>
				terminal.resolve(outcome);
			const expiry = Promise.withResolvers<void>();
			const retry = retries.retryWithBackoff;
			spyOn(retries, "retryWithBackoff").mockImplementation(
				async (action, options) => {
					if (options?.baseDelayMs !== 500) return retry(action, options);
					await expiry.promise;
					return action();
				},
			);
			if (schedule !== "down-reply-lost")
				f.deps.pollHotspotActive = async () => false;
			expect(await f.start()).toEqual({ success: true });
			if (schedule === "down-reply-lost") {
				f.faults.downTimeout = true;
				f.misreadNextLegSample();
				await handleWifiMonitorEvent({
					type: "device-state",
					device: LEG,
					state: "connected",
				});
				expiry.resolve();
			} else {
				if (schedule === "idle") f.observe(undefined, "ap");
				expiry.resolve();
			}
			expect(await terminal.promise).toMatchObject({
				success: false,
				error:
					schedule === "down-reply-lost" ? "radio-changed" : "not-confirmed",
			});
			if (schedule === "busy") {
				expect(leg.autoconnect()).toBe("no");
				f.observe(undefined, "ap");
				const owner = resolveWifiAdapterOwner(MAC, f.row);
				await withWifiAdapterLock(wifiAdapterLockKey(owner), () =>
					reconcileWifiAdapterTeardownLocked(owner),
				);
			}
			expect(leg.autoconnect()).toBe("yes");
		} finally {
			cancelWifiAdapterReconciliation();
			resetConcurrentInterfaceDepsForTest();
			await f.restore();
		}
	},
);

test("a saved hybrid channel refusal without an Up path does not Down the successor by UUID", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		const connect = f.deps.nmConnect;
		f.deps.nmConnect = (id, timeout) => connect(id, timeout);
		f.deps.confirmHybridActivation = async () => {
			await connect(uuid, HOTSPOT_UP_TO);
			return false;
		};
		expect(await f.start()).toMatchObject({
			success: false,
			reason: "deactivation-failed",
		});
		expect(f.active()).toBe(uuid);
	} finally {
		await f.restore();
	}
});

test("a pre-Up hybrid Save refusal leaves the profile active off the selected leg", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.observe(uuid, "ap");
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const readDevice = nm.nmDeviceProp;
		spyOn(nm, "nmDeviceProp").mockImplementation(
			async (ifname, fields, mode) =>
				fields.startsWith("GENERAL.STATE") && ifname === LEG
					? ["30", "", ""]
					: readDevice(ifname, fields, mode),
		);
		const beginning = f.commands.length;
		expect(
			await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
				...defaultHotspotConfigDeps,
				...qualifiedHybridEvidence,
				readHybridChannel: async () => undefined,
				readHybridTargetIdentity: async () => f.leg(),
			}),
		).toBe(false);
		expect(f.active()).toBe(uuid);
		expect(
			f.commands.slice(beginning).filter((args) => args[1] === "down"),
		).toEqual([]);
	} finally {
		await f.restore();
	}
});

test("a station roam during rollback Up stops only the unconfirmed hybrid activation", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const beginning = f.commands.length;
		const stableChannel = qualifiedHybridEvidence.readHybridChannel;
		let roamed = false;
		let rollbackPath = "";
		let ups = 0;
		expect(
			await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
				...defaultHotspotConfigDeps,
				...qualifiedHybridEvidence,
				readHybridChannel: stableChannel,
				readHybridTargetIdentity: async () => f.leg(),
				nmConnect: async (...args) => {
					if (++ups === 1) return false;
					const result = await defaultHotspotConfigDeps.nmConnect(...args);
					rollbackPath = f.nm.activePath();
					roamed = true;
					return result;
				},
				confirmHybridActivation: async () => !roamed,
				broadcastState: () => undefined,
			}),
		).toBe(false);
		expect(ups).toBe(2);
		expect(f.active()).toBeUndefined();
		expect(rollbackPath).not.toBe("");
		expect(
			f.commands.slice(beginning).filter((args) => args[1] === "down"),
		).toEqual([["conn", "down", "apath", rollbackPath]]);
	} finally {
		await f.restore();
	}
});

test("a same-UUID same-channel successor cannot confirm hybrid Save", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		let ownedPath = "";
		const remember = spyOn(defaultHotspotConfigDeps, "rememberCredentials");
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...defaultHotspotConfigDeps,
			...qualifiedHybridEvidence,
			readHybridTargetIdentity: async () => f.leg(),
			confirmHybridActivation: async () => {
				ownedPath = f.nm.activePath();
				f.nm.activate(uuid);
				return true;
			},
			broadcastState: () => undefined,
		});
		expect(result).toBe(false);
		expect(ownedPath).not.toBe("");
		expect(f.nm.activePath()).not.toBe(ownedPath);
		expect(f.active()).toBe(uuid);
		expect(remember).not.toHaveBeenCalled();
	} finally {
		await f.restore();
	}
});

test("hybrid Save refuses a same-UUID successor created during saved-profile refresh", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		let original = "";
		let successor = "";
		const remember = spyOn(defaultHotspotConfigDeps, "rememberCredentials");
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...defaultHotspotConfigDeps,
			...qualifiedHybridEvidence,
			readHybridTargetIdentity: async () => f.leg(),
			wifiUpdateSavedConns: async () => {
				original = f.nm.activePath();
				successor = f.nm.activate(uuid);
			},
			broadcastState: () => undefined,
		});
		expect(result).toBe(false);
		expect(remember).not.toHaveBeenCalled();
		expect(f.inspectedDownPaths).toEqual([original]);
		expect(successor).not.toBe(original);
		expect(f.nm.activePath()).toBe(successor);
		expect(f.active()).toBe(uuid);
	} finally {
		await f.restore();
	}
});

test("an acknowledged rollback with failed profile readback confirms and cleans up its exact hybrid Up", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const hotspot = f.row.hotspot;
		const beginning = f.commands.length;
		const readProfile = profiles.readNmProfileInstance;
		const instance = spyOn(profiles, "readNmProfileInstance");
		const confirmations: string[] = [];
		let ups = 0;
		let rollbackPath = "";
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...defaultHotspotConfigDeps,
			...qualifiedHybridEvidence,
			readHybridTargetIdentity: async () => f.leg(),
			confirmHybridActivation: async (
				_parent,
				_leg,
				_id,
				_channel,
				receipt,
			) => {
				if (receipt) confirmations.push(receipt.path);
				return false;
			},
			nmConnect: async (...args) => {
				if (++ups === 1) return false;
				const up = await defaultHotspotConfigDeps.nmConnect(...args);
				rollbackPath = f.nm.activePath();
				instance.mockImplementationOnce(async () => undefined);
				return up;
			},
			broadcastState: () => undefined,
		});
		expect(result).toBe(false);
		expect(ups).toBe(2);
		expect(f.row.hotspot).toBe(hotspot);
		expect(f.row.hotspot.conn).toBe(uuid);
		expect(await readProfile(uuid)).toBeDefined();
		expect(f.active()).toBeUndefined();
		expect(confirmations).toEqual([rollbackPath]);
		expect(
			f.commands.slice(beginning).filter((args) => args[1] === "down"),
		).toEqual([["conn", "down", "apath", rollbackPath]]);
	} finally {
		await f.restore();
	}
});

test("a post-Up hybrid Save channel refusal leaves a same-profile successor active", async () => {
	const f = await hybrid();
	try {
		const uuid = await f.afterSavedStart();
		f.row.concurrentHotspot = { ifname: LEG, activeConn: uuid };
		const beginning = f.commands.length;
		let restartPath = "";
		const result = await reconfigureHotspotForRegdomain(MAC, f.row, "auto", {
			...defaultHotspotConfigDeps,
			...qualifiedHybridEvidence,
			readHybridTargetIdentity: async () => f.leg(),
			confirmHybridActivation: async () => {
				restartPath = f.nm.activePath();
				f.nm.activate(uuid);
				return false;
			},
			broadcastState: () => undefined,
		});
		expect(result).toBe(false);
		expect(restartPath).not.toBe("");
		expect(f.active()).toBe(uuid);
		expect(
			f.commands.slice(beginning).filter((args) => args[1] === "down"),
		).toEqual([]);
		expect(f.inspectedDownPaths).toEqual([restartPath]);
	} finally {
		await f.restore();
	}
});

test.each(["removed", "replaced"] as const)(
	"deferred hybrid failure retires a %s leg claim without restoring policy onto a successor",
	async (loss) => {
		const f = await hybrid();
		try {
			const leg = await borrowLeg(f);
			const terminal = Promise.withResolvers<unknown>();
			const releasePoll = Promise.withResolvers<void>();
			f.deps.pollHotspotActive = async () => false;
			f.deps.publishOutcome = (_kind, _device, outcome) =>
				terminal.resolve(outcome);
			const retry = retries.retryWithBackoff;
			spyOn(retries, "retryWithBackoff").mockImplementation(
				async (action, options) => {
					if (!options?.signal) return retry(action, options);
					await releasePoll.promise;
					return action();
				},
			);
			expect(await f.start()).toEqual({ success: true });
			f.observe(undefined, "ap");
			if (loss === "removed") {
				spyOn(radioIdentityReaders, "listInterfaces").mockResolvedValue([
					"wlan0",
				]);
				f.loseNextLegSample();
			} else f.replaceLeg();
			releasePoll.resolve();

			expect(await terminal.promise).toEqual({
				success: false,
				error: "not-confirmed",
			});
			expect(
				selectedTargets.get(LEG)?.record?.priorAutoconnect,
			).toBeUndefined();
			expect(f.row.concurrentHotspot?.activeConn ?? null).toBeNull();
			expect(leg.writes).toEqual([]);
		} finally {
			cancelWifiAdapterReconciliation();
			resetConcurrentInterfaceDepsForTest();
			await f.restore();
		}
	},
);
