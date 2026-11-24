import { expect, test } from "bun:test";
import { SteeringUnavailableError } from "../modules/network/uplink-steering/contracts.ts";
import type { MarkAdmission } from "../modules/network/uplink-steering/mark-admission.ts";
import { SteeringMarkLifecycle } from "../modules/network/uplink-steering/mark-lifecycle.ts";
import { observeKernelMarks } from "../modules/network/uplink-steering/mark-observation.ts";
import { shaperSteeringContext } from "../modules/network/uplink-steering/runtime.ts";

const legacy = `
	chain postrouting {
		type nat hook postrouting priority srcnat; policy accept;
		iifname "eth9" ip saddr 10.90.0.0/24 ct mark & 0xffffff00 == 0xca671800 oifname "wwan1" masquerade
	}
`;
const independent = {
	identity: "independent",
	ifname: "wwan2",
	mark: 0xca010000,
	weight: 100,
	selectable: true,
};

// Unedited `nft -nn list ruleset` output, nftables 1.1.7 in a netns.
// buildMarkGuard installed numeric oif 3 (wwan0) and oif 4 (wwan1).
const capturedGuard = `table inet ceralive_share_guard {
	chain assignment_7 {
	}

	chain affected_ca671800 {
	}

	chain egress {
		type filter hook postrouting priority -150; policy accept;
		iifname "eth9" ip saddr 10.90.0.0/24 meta mark & 0xffffff00 == 0xca671800 oif "wwan0" accept
		iifname "eth9" ip saddr 10.90.0.0/24 meta mark & 0xffffff00 == 0xca010000 oif "wwan1" accept
		iifname "eth9" ip saddr 10.90.0.0/24 drop
	}
}
`;

test("quarantine retains an unaffected admission from a real named oif listing", async () => {
	const admitted: MarkAdmission[] = [];
	const marks = faultFixture({
		observe: () =>
			observeKernelMarks(async (bin, args) => {
				switch (`${bin} ${args.join(" ")}`) {
					case "nft -nn list ruleset":
						return capturedGuard;
					case "ip rule show":
						return "110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30000\n";
					case "ip -o link show dev wwan1":
						return "4: wwan1: <BROADCAST,NOARP> mtu 1500 state DOWN\n";
					default:
						throw new Error(`unexpected command ${bin} ${args.join(" ")}`);
				}
			}),
		guard: async (admission) => {
			admitted.push(admission);
		},
	});
	await expect(marks.marks([independent])).rejects.toMatchObject({
		reason: "mark_collision",
	});
	expect(admitted).toEqual([
		{
			seq: 0,
			phase: "fenced",
			zones: [{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" }],
			affected: [0xca671800],
			claims: [{ mark: independent.mark, ifindex: 4, epoch: 0 }],
		},
	]);
});

test("a device re-created between the listing and the name lookup keeps no admission", async () => {
	const listings = [
		capturedGuard,
		capturedGuard.replace('oif "wwan1"', "oif 4"),
	];
	const observed = await observeKernelMarks(async (bin, args) => {
		switch (`${bin} ${args.join(" ")}`) {
			case "nft -nn list ruleset":
				return listings.shift() ?? "";
			case "ip rule show":
				return "";
			case "ip -o link show dev wwan1":
				return "13: wwan1: <BROADCAST,NOARP> mtu 1500 state DOWN\n";
			default:
				throw new Error(`unexpected command ${bin} ${args.join(" ")}`);
		}
	});
	expect(observed.unaffected).toEqual([]);
});

test("reads only the owned inet steering tables, receipt, protected zones and unaffected admission", async () => {
	const ruleset = `table ip ceralive_share_guard {
	chain assignment_99 {
	}
}
table inet ceralive_share {${legacy}}
table inet ceralive_share_guard {
	chain assignment_7 {
	}
	chain affected_ca671800 {
	}
	chain egress {
		type filter hook postrouting priority mangle; policy accept;
		iifname "eth9" ip saddr 10.90.0.0/24 meta mark & 0xffffff00 == 0xca671800 oif 4 accept
		iifname "eth9" ip saddr 10.90.0.0/24 meta mark & 0xffffff00 == 0xca010000 oif 5 accept
		iifname "eth9" ip saddr 10.90.0.0/24 drop
		iifname "eth8" ip saddr 10.91.0.2 drop
	}
}
table inet foreign {
	chain affected_ca010000 { }
}`;
	const observed = await observeKernelMarks(async (bin, args) => {
		if (bin === "nft" && args.join(" ") === "-nn list ruleset") return ruleset;
		if (bin === "ip" && args.join(" ") === "rule show")
			return "0:\tfrom all lookup local\n110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30000\n";
		throw new Error(`unexpected command ${bin}`);
	});
	expect(observed).toEqual({
		guard: "assignment_7",
		fence: true,
		legacy,
		protectedZones: [
			{ ifname: "eth9", ipv4Cidr: "10.90.0.0/24" },
			{ ifname: "eth8", ipv4Cidr: "10.91.0.2/32" },
		],
		affected: [0xca671800],
		unaffected: [{ mark: 0xca010000, ifindex: 5 }],
	});
});

test.each(["unreadable journal", "unavailable observation"] as const)(
	"%s does not prevent a singleton from taking its natural mark",
	async (fault) => {
		const marks = faultFixture({
			observe: async () => {
				if (fault === "unavailable observation")
					throw new Error("nft unavailable");
				return { guard: "", fence: false, legacy: "" };
			},
			guard: async () => {
				throw new Error("no guard owns the singleton");
			},
		});
		expect(await marks.marks([independent])).toEqual(
			new Map([[independent.identity, independent.mark]]),
		);
	},
);

test("a bad journal under an existing guard keeps only its verified unaffected admission", async () => {
	const admitted: MarkAdmission[] = [];
	const zone = { ifname: "eth9", ipv4Cidr: "10.90.0.0/24" };
	const marks = faultFixture({
		observe: async () => ({
			guard: "assignment_7",
			fence: true,
			legacy,
			protectedZones: [zone],
			affected: [0xca671800],
			unaffected: [{ mark: independent.mark, ifindex: 5 }],
		}),
		guard: async (admission) => {
			admitted.push(admission);
		},
	});
	await expect(marks.marks([independent])).rejects.toMatchObject({
		reason: "mark_collision",
	});
	expect(admitted).toEqual([
		{
			seq: 0,
			phase: "fenced",
			zones: [zone],
			affected: [0xca671800],
			claims: [{ mark: independent.mark, ifindex: 5, epoch: 0 }],
		},
	]);
});

function faultFixture(
	deps: Pick<
		ConstructorParameters<typeof SteeringMarkLifecycle>[0],
		"observe" | "guard"
	>,
) {
	const unexpected = async () => {
		throw new Error("unexpected kernel mutation");
	};
	return new SteeringMarkLifecycle({
		...deps,
		journal: {
			load: async () => {
				throw new SteeringUnavailableError(
					"mark_collision",
					"unreadable journal",
				);
			},
			save: unexpected,
		},
		linkIndex: async () => 5,
		armFence: unexpected,
		retire: unexpected,
		ensure: unexpected,
		flush: unexpected,
		publish: unexpected,
		applyLegacy: unexpected,
	});
}

test("does not mistake a malformed guard or a foreign policy for an absent guard or owned fence", async () => {
	const observed = await observeKernelMarks(async (bin) =>
		bin === "nft"
			? "table inet ceralive_share_guard {\n chain unrelated { }\n}\n"
			: "110:\tfrom all fwmark 0xca000000/0xff000000 lookup 30001\n",
	);
	expect(observed).toEqual({
		guard: "invalid",
		legacy: "",
		fence: false,
		protectedZones: [],
		affected: [],
		unaffected: [],
	});
});

test("uncommitted collision contenders are omitted from shaping but the unrelated live mark is kept", async () => {
	const resolve = shaperSteeringContext.resolveMarks;
	if (resolve === undefined) throw new Error("the shaper has no mark resolver");
	const link = { weight: 100, selectable: true };
	expect(
		await resolve([
			{ ...link, identity: "a", ifname: "wwan0", mark: 0xca671800 },
			{ ...link, identity: "b", ifname: "wwan1", mark: 0xca671800 },
			{ ...link, identity: "c", ifname: "wwan2", mark: 0xca010000 },
		]),
	).toEqual(new Map([["c", 0xca010000]]));
});
