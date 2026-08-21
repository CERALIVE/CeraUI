/**
 * Todo 22 STAGE B — the LAN-subnet rewrite, and the auto-restore behind it.
 *
 * This is the only router write that can cost the path to the device receiving
 * it, so the tests that matter are not the happy one. The critical case is the
 * THIRD describe: the write is dispatched, the device never answers at its new
 * address, and the machine puts the previous record back and PROVES the device is
 * reachable under it before it reports anything. A restore that cannot be proven
 * must leave the mutation unconfirmed, so the journal keeps the device blocked.
 *
 * The device model here is deliberately physical rather than script-shaped: a
 * dongle answers at exactly ONE address — the one in the record it currently
 * holds — and the host may or may not have a route to it. That is what lets the
 * "the write landed but the host could not follow" case be distinguished from
 * "the write never landed", which is the distinction the whole restore path
 * exists to make.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hilinkDhcpSettingsBody } from "../modules/network/hilink-documents.ts";
import {
	executeSubnetRewrite,
	parseHostSubnets,
	prepareSubnetRewrite,
	restoreSubnet,
	type SubnetRewriteDeps,
	type SubnetRewritePlan,
} from "../modules/network/router-subnet-hygiene.ts";
import {
	dhcpRecordsMatch,
	type HilinkDhcpRecord,
	parseHilinkDhcpSettings,
	planSubnetRewrite,
	subnetOf,
} from "../modules/network/router-subnet-plan.ts";
import {
	planFromPreState,
	preStateFor,
} from "../modules/network/router-subnet-rollback.ts";

const HILINK = "12d1:14dc";
const IFNAME = "enx0c5b8f279a64";

const FACTORY: HilinkDhcpRecord = {
	address: "192.168.8.1",
	netmask: "255.255.255.0",
	dhcpStatus: "1",
	startAddress: "192.168.8.100",
	endAddress: "192.168.8.200",
	leaseTime: "86400",
	dnsStatus: "1",
	primaryDns: "192.168.8.1",
	secondaryDns: "8.8.8.8",
};

function recordDocument(record: HilinkDhcpRecord): string {
	return `<?xml version="1.0" encoding="UTF-8"?><response>${hilinkDhcpSettingsBody(
		record,
	)
		.replace(/^[\s\S]*?<request>/, "")
		.replace("</request>", "")}</response>`
		.replace("<request>", "")
		.replace(/DhcpIPAddress/g, "DhcpIPAddress");
}

const SESSION = `<response><SesInfo>SessionID=abc</SesInfo><TokInfo>token</TokInfo></response>`;

/**
 * A dongle plus the host's route to it.
 *
 * `answersAt` models the ROUTE, not the device: the device is always at the
 * address in its own record, and a probe fails when the host cannot reach that
 * address yet. Every test that matters is a statement about those two moving
 * apart.
 */
function bench(options: {
	readonly record?: HilinkDhcpRecord;
	/** Whether the host can reach an address right now. Called per probe. */
	readonly answersAt?: (address: string, probe: number) => boolean;
	/** Whether a POST to `/api/dhcp/settings` actually moves the device. */
	readonly writeLands?: boolean;
	readonly hostSubnets?: string;
}): {
	deps: SubnetRewriteDeps;
	current: () => HilinkDhcpRecord;
	posts: () => number;
	renewals: () => number;
} {
	let record = options.record ?? FACTORY;
	let probe = 0;
	let posts = 0;
	let renewals = 0;
	const answersAt = options.answersAt ?? (() => true);
	const writeLands = options.writeLands ?? true;

	const hostOf = (url: string): string => url.replace("http://", "");
	const reachable = (url: string): boolean => {
		probe += 1;
		const host = hostOf(url).split("/")[0] ?? "";
		return host === record.address && answersAt(host, probe);
	};

	const deps: SubnetRewriteDeps = {
		isRealDevice: () => Promise.resolve(true),
		runIpRouteShowDefault: () =>
			Promise.resolve(
				`default via ${record.address} dev ${IFNAME} metric 100\n`,
			),
		runIpAddrShow: () =>
			Promise.resolve(
				options.hostSubnets ??
					`3: ${IFNAME}    inet 192.168.8.100/24 brd 192.168.8.255 scope global ${IFNAME}\n`,
			),
		renewDhcpLease: () => {
			renewals += 1;
			return Promise.resolve();
		},
		wait: () => Promise.resolve(),
		fetchViaInterface: (_ifname, urls) =>
			Promise.resolve(
				urls.map((url) => {
					if (!reachable(url)) return "";
					if (url.endsWith("/api/webserver/SesTokInfo")) return SESSION;
					if (url.endsWith("/api/dhcp/settings")) return recordDocument(record);
					return "";
				}),
			),
		postViaInterface: (_ifname, url, body) => {
			posts += 1;
			const host = hostOf(url).split("/")[0] ?? "";
			if (host !== record.address) return Promise.resolve("");
			if (writeLands && url.endsWith("/api/dhcp/settings")) {
				const parsed = parseHilinkDhcpSettings(
					body
						.replace("<request>", "<response>")
						.replace("</request>", "</response>"),
				);
				if (parsed !== undefined) record = parsed;
			}
			return Promise.resolve("<response>OK</response>");
		},
	};
	return {
		deps,
		current: () => record,
		posts: () => posts,
		renewals: () => renewals,
	};
}

async function planFor(
	unit: ReturnType<typeof bench>,
	target = "192.168.9.1",
): Promise<SubnetRewritePlan> {
	const prepared = await prepareSubnetRewrite(
		IFNAME,
		HILINK,
		target,
		unit.deps,
	);
	if (!prepared.ok) throw new Error(`preflight refused: ${prepared.reason}`);
	return prepared.plan;
}

describe("the plan refuses more than it accepts", () => {
	test("a non-/24 record is refused rather than re-hosted by guess", () => {
		const plan = planSubnetRewrite(
			{ ...FACTORY, netmask: "255.255.0.0" },
			"192.168.9.1",
			new Map(),
		);
		expect(plan).toEqual({ ok: false, reason: "unsupported_netmask" });
	});

	test("a public or malformed target is refused", () => {
		for (const target of [
			"8.8.8.8",
			"not-an-address",
			"192.168.9.0",
			"999.1.1.1",
		]) {
			expect(planSubnetRewrite(FACTORY, target, new Map()).ok).toBe(false);
		}
	});

	test("moving to the subnet it is already on is not a change", () => {
		expect(planSubnetRewrite(FACTORY, "192.168.8.1", new Map())).toEqual({
			ok: false,
			reason: "no_change",
		});
	});

	test("a colliding target NAMES the interface already holding it", () => {
		const plan = planSubnetRewrite(
			FACTORY,
			"192.168.9.1",
			new Map([["eth0", "192.168.9.0"]]),
		);
		expect(plan).toEqual({
			ok: false,
			reason: "subnet_conflict",
			conflict: "eth0",
		});
	});

	test("the pool and the device's own DNS follow; an upstream resolver does not", () => {
		const plan = planSubnetRewrite(FACTORY, "192.168.9.1", new Map());
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.target).toEqual({
			...FACTORY,
			address: "192.168.9.1",
			startAddress: "192.168.9.100",
			endAddress: "192.168.9.200",
			// It pointed at the dongle itself, so it moves with the dongle…
			primaryDns: "192.168.9.1",
			// …and this one is the operator's own upstream resolver, untouched.
			secondaryDns: "8.8.8.8",
		});
	});

	test("the lease time and the DHCP/DNS enable flags are CARRIED, not reset", () => {
		const custom = { ...FACTORY, leaseTime: "3600", dnsStatus: "0" };
		const plan = planSubnetRewrite(custom, "10.20.30.1", new Map());
		expect(plan.ok).toBe(true);
		if (!plan.ok) throw new Error("unreachable");
		expect(plan.target.leaseTime).toBe("3600");
		expect(plan.target.dnsStatus).toBe("0");
	});

	test("`ip -4 -o addr show` yields one /24 per interface, and skips the rest", () => {
		const subnets = parseHostSubnets(
			[
				"1: lo    inet 127.0.0.1/8 scope host lo",
				"3: eth0    inet 192.168.0.42/24 brd 192.168.0.255 scope global eth0",
				`4: ${IFNAME}    inet 192.168.8.100/24 scope global ${IFNAME}`,
				"5: tun0    inet 10.8.0.2/32 scope global tun0",
			].join("\n"),
		);
		expect([...subnets]).toEqual([
			["eth0", "192.168.0.0"],
			[IFNAME, "192.168.8.0"],
		]);
	});

	test("subnetOf answers only for the mask this module reasons about", () => {
		expect(subnetOf("192.168.8.100", "255.255.255.0")).toBe("192.168.8.0");
		expect(subnetOf("192.168.8.100", "255.255.0.0")).toBeUndefined();
	});
});

describe("preflight reads the device before anything is armed", () => {
	test("refuses a dialect this build has no subnet write for", async () => {
		const unit = bench({});
		const prepared = await prepareSubnetRewrite(
			IFNAME,
			"19d2:1405",
			"192.168.9.1",
			unit.deps,
		);
		expect(prepared).toEqual({ ok: false, reason: "unsupported" });
	});

	test("refuses when the device's own record cannot be read", async () => {
		const unit = bench({ answersAt: () => false });
		const prepared = await prepareSubnetRewrite(
			IFNAME,
			HILINK,
			"192.168.9.1",
			unit.deps,
		);
		expect(prepared).toEqual({ ok: false, reason: "unreadable" });
	});

	test("does not count the dongle's OWN subnet as a conflict", async () => {
		// The host holds 192.168.8.100/24 through this very interface. Counting it
		// would make every rewrite look like a collision with itself.
		const unit = bench({});
		const prepared = await prepareSubnetRewrite(
			IFNAME,
			HILINK,
			"192.168.9.1",
			unit.deps,
		);
		expect(prepared.ok).toBe(true);
	});

	test("a sibling interface's subnet IS a conflict, and is named", async () => {
		const unit = bench({
			hostSubnets: `3: eth0    inet 192.168.9.5/24 scope global eth0\n`,
		});
		const prepared = await prepareSubnetRewrite(
			IFNAME,
			HILINK,
			"192.168.9.1",
			unit.deps,
		);
		expect(prepared).toEqual({
			ok: false,
			reason: "subnet_conflict",
			conflict: "eth0",
		});
	});
});

describe("the rewrite, and the AUTO-RESTORE when it does not answer", () => {
	test("a device that answers at its new address is applied", async () => {
		const unit = bench({});
		const plan = await planFor(unit);

		const outcome = await executeSubnetRewrite(
			plan,
			() => Promise.resolve(),
			unit.deps,
		);

		expect(outcome.status).toBe("applied");
		expect(unit.current().address).toBe("192.168.9.1");
		expect(unit.renewals()).toBeGreaterThan(0);
	});

	test("the write REPLACES the whole record, pool and all", async () => {
		const unit = bench({});
		const plan = await planFor(unit);

		await executeSubnetRewrite(plan, () => Promise.resolve(), unit.deps);

		expect(unit.current()).toEqual({
			...FACTORY,
			address: "192.168.9.1",
			startAddress: "192.168.9.100",
			endAddress: "192.168.9.200",
			primaryDns: "192.168.9.1",
			secondaryDns: "8.8.8.8",
		});
	});

	test("A WRITE THE FIRMWARE DID NOT APPLY AUTO-RESTORES and reports reverted", async () => {
		// The vendor answered OK and moved nothing — the "control that shows
		// success and changes nothing" this surface exists to refuse. The device
		// is still at its old address holding its old record, so reachability is
		// reconfirmed there and the mutation resolves rather than blocking.
		const unit = bench({ writeLands: false });
		const plan = await planFor(unit);

		const outcome = await executeSubnetRewrite(
			plan,
			() => Promise.resolve(),
			unit.deps,
		);

		expect(outcome.status).toBe("reverted");
		expect(unit.current()).toEqual(FACTORY);
	});

	test("A WRITE THAT LANDED BUT WAS UNREACHABLE IS PUT BACK, AND RECONFIRMED", async () => {
		// The critical case. The device DID move, so the old address is silent and
		// the host's route only catches up after the confirm window has already
		// given up. The restore's own search is what then finds it — which is
		// exactly why the old address is RETAINED and both are probed — and the
		// previous record is only reported restored once the device answers at its
		// OLD address again.
		let round = 0;
		const unit = bench({
			answersAt: (address) => (address === "192.168.9.1" ? round >= 6 : true),
		});
		const plan = await planFor(unit);
		// Each confirm round ends in a wait, so counting them is a deterministic
		// stand-in for "the window elapsed" without a real timer.
		const slowRoute: SubnetRewriteDeps = {
			...unit.deps,
			wait: () => {
				round += 1;
				return Promise.resolve();
			},
		};

		const outcome = await executeSubnetRewrite(
			plan,
			() => Promise.resolve(),
			slowRoute,
		);

		expect(outcome.status).toBe("reverted");
		expect(unit.current()).toEqual(FACTORY);
	});

	test("a device that answers NOWHERE leaves the mutation UNCONFIRMED", async () => {
		// The write landed, and the host's route never followed it — so the device
		// is somewhere the host cannot reach and the restore cannot be attempted,
		// let alone proven. This is the one outcome that must stay unconfirmed.
		const unit = bench({ answersAt: (address) => address === FACTORY.address });
		const plan = await planFor(unit);

		const outcome = await executeSubnetRewrite(
			plan,
			() => Promise.resolve(),
			unit.deps,
		);

		expect(outcome.status).toBe("blocked");
		if (outcome.status !== "blocked") throw new Error("unreachable");
		// The detail names BOTH addresses, because "somewhere between these two" is
		// the only honest description of where the dongle now is.
		expect(outcome.detail).toContain("192.168.9.1");
		expect(outcome.detail).toContain("192.168.8.1");
	});

	test("a record that moved between preflight and the lease is refused, unwritten", async () => {
		const unit = bench({});
		const plan = await planFor(unit);
		const drifted: SubnetRewritePlan = {
			...plan,
			current: { ...plan.current, startAddress: "192.168.8.150" },
		};

		const outcome = await executeSubnetRewrite(
			drifted,
			() => Promise.resolve(),
			unit.deps,
		);

		expect(outcome).toEqual({ status: "refused", reason: "state_drifted" });
		expect(unit.posts()).toBe(0);
		expect(unit.current()).toEqual(FACTORY);
	});

	test("`markExecuting` is journaled BEFORE the device is written", async () => {
		const unit = bench({});
		const plan = await planFor(unit);
		const order: string[] = [];
		const marking: SubnetRewriteDeps = {
			...unit.deps,
			postViaInterface: (ifname, url, body, headers) => {
				order.push("write");
				return unit.deps.postViaInterface(ifname, url, body, headers);
			},
		};

		await executeSubnetRewrite(
			plan,
			() => {
				order.push("executing");
				return Promise.resolve();
			},
			marking,
		);

		expect(order[0]).toBe("executing");
		expect(order[1]).toBe("write");
	});
});

describe("startup replay recovers through the SAME code the live path runs", () => {
	test("the journaled pre-state round-trips back into a plan", async () => {
		const unit = bench({});
		const plan = await planFor(unit);

		expect(planFromPreState(preStateFor(plan))).toEqual(plan);
	});

	test("a pre-state this build cannot read yields NO plan — fail-closed", () => {
		expect(planFromPreState({})).toBeUndefined();
		expect(
			planFromPreState({ ifname: IFNAME, adminUrl: "http://x" }),
		).toBeUndefined();
		expect(
			planFromPreState({
				ifname: IFNAME,
				adminUrl: "http://x",
				current: { address: "192.168.8.1" },
				target: { ...FACTORY, address: "192.168.9.1" },
			}),
		).toBeUndefined();
	});

	test("a replayed restore puts the record back and reconfirms it", async () => {
		const moved: HilinkDhcpRecord = {
			...FACTORY,
			address: "192.168.9.1",
			startAddress: "192.168.9.100",
			endAddress: "192.168.9.200",
			primaryDns: "192.168.9.1",
		};
		const unit = bench({ record: moved });
		const plan: SubnetRewritePlan = {
			ifname: IFNAME,
			adminUrl: "http://192.168.8.1",
			current: FACTORY,
			target: moved,
		};

		expect(await restoreSubnet(plan, unit.deps)).toBe(true);
		expect(unit.current()).toEqual(FACTORY);
	});

	test("a restore that cannot find the device at all is a FAILURE, never a shrug", async () => {
		const unit = bench({ answersAt: () => false });
		const plan: SubnetRewritePlan = {
			ifname: IFNAME,
			adminUrl: "http://192.168.8.1",
			current: FACTORY,
			target: { ...FACTORY, address: "192.168.9.1" },
		};

		expect(await restoreSubnet(plan, unit.deps)).toBe(false);
	});
});

describe("it is HYGIENE — never a bonding prerequisite", () => {
	function stripComments(source: string): string {
		return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
	}

	/**
	 * The fence is on the IMPORT GRAPH rather than on prose: a bonding module that
	 * cannot name this one cannot make it a precondition, however the copy is
	 * later worded.
	 */
	test("no bonding or link-publication module imports the subnet operation", () => {
		const bondingModules = [
			join("modules", "streaming", "srtla.ts"),
			join("modules", "streaming", "bind-map.ts"),
			join("modules", "streaming", "bind-map-writer.ts"),
			join("modules", "streaming", "bind-map-spawn.ts"),
			join("modules", "network", "network-interfaces.ts"),
		];
		for (const relative of bondingModules) {
			const code = stripComments(
				readFileSync(join(import.meta.dir, "..", relative), "utf8"),
			);
			expect(code).not.toContain("router-subnet-hygiene");
			expect(code).not.toContain("router-subnet-plan");
			expect(code).not.toContain("prepareSubnetRewrite");
		}
	});

	test("…and the hygiene module names no bonding concept either", () => {
		const code = stripComments(
			readFileSync(
				join(
					import.meta.dir,
					"..",
					"modules",
					"network",
					"router-subnet-hygiene.ts",
				),
				"utf8",
			),
		);
		for (const bondingToken of [
			"srtla",
			"bind-map",
			"genSrtlaIpList",
			"bond",
		]) {
			expect(code).not.toContain(bondingToken);
		}
	});
});

describe("the record parser", () => {
	test("requires the address AND the mask — there is no subnet without both", () => {
		expect(
			parseHilinkDhcpSettings(
				"<response><DhcpIPAddress>192.168.8.1</DhcpIPAddress></response>",
			),
		).toBeUndefined();
	});

	test("falls back per field so an echo cannot clear an untouched setting", () => {
		const parsed = parseHilinkDhcpSettings(
			"<response><DhcpIPAddress>192.168.8.1</DhcpIPAddress><DhcpLanNetmask>255.255.255.0</DhcpLanNetmask></response>",
		);
		expect(parsed?.dhcpStatus).toBe("1");
		expect(parsed?.leaseTime).toBe("86400");
		expect(parsed?.primaryDns).toBe("192.168.8.1");
	});

	test("drift is judged on the fields a rewrite actually moves", () => {
		expect(dhcpRecordsMatch(FACTORY, { ...FACTORY, leaseTime: "10" })).toBe(
			true,
		);
		expect(
			dhcpRecordsMatch(FACTORY, { ...FACTORY, startAddress: "192.168.8.5" }),
		).toBe(false);
	});
});
