import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { call } from "@orpc/server";

import { mintLinkId } from "../modules/modems/physical-identity.ts";
import {
	getNetworkInterfaces,
	netIfBuildMsg,
} from "../modules/network/network-interfaces.ts";
import {
	genSrtlaBondEntries,
	setBondIdentityResolverForTest,
} from "../modules/streaming/srtla.ts";
import { configureNetworkInterfaceProcedure } from "../rpc/procedures/network.procedure.ts";
import {
	attachHuaweiTwins,
	HUAWEI_TWIN_IP,
	installHuaweiIdentityResolver,
	makeRpcContext,
	resetBondFixture,
} from "./helpers/bond-toggle-fixture.ts";

describe("duplicate-IP bond eligibility — one displayed and admitted verdict", () => {
	beforeEach(() => {
		resetBondFixture();
		installHuaweiIdentityResolver();
		attachHuaweiTwins();
	});

	afterEach(() => {
		resetBondFixture();
	});

	test("a mappable duplicate-IP link is shown included and enters the IP/bind map", () => {
		// Given a duplicate-IP twin whose physical identity can produce a bind row.
		const wire = netIfBuildMsg();

		// When both the display and sender admission ask their bond verdict.
		const entries = genSrtlaBondEntries();

		// Then they agree that the link is included.
		expect(wire.eth1?.enabled).toBe(true);
		expect(entries.some((entry) => entry.iface === "eth1")).toBe(true);
	});

	test("an unmappable duplicate-IP include is honestly refused and stays excluded", async () => {
		// Given identity resolution fails for one twin, so no sidecar row can name it.
		setBondIdentityResolverForTest((ifname) => {
			if (ifname === "eth1") throw new Error("descriptor unavailable");
			return {
				identityKey: `physical:${ifname}`,
				anchor: "id-path",
				linkId: mintLinkId(`physical:${ifname}`),
				stableKey: `physical:${ifname}`,
				ifname,
				displayName: "Huawei E3372",
			};
		});

		// When the operator requests inclusion.
		const result = await call(
			configureNetworkInterfaceProcedure,
			{ name: "eth1", ip: HUAWEI_TWIN_IP, enabled: true },
			{ context: makeRpcContext() },
		);

		// Then the request is refused with a typed reason, and BOTH projections
		// exclude the link rather than accept-then-revert.
		expect(result.success).toBe(false);
		expect(result.error).toBe("bond_unmappable");
		expect(netIfBuildMsg().eth1?.enabled).toBe(false);
		expect(genSrtlaBondEntries().some((entry) => entry.iface === "eth1")).toBe(
			false,
		);
		expect(getNetworkInterfaces().eth1?.error).not.toBe(0);
	});
});
