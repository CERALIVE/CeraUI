import { afterEach, expect, jest, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as runner from "../helpers/run.ts";
import { hilinkDhcpSettingsBody } from "../modules/network/hilink-documents.ts";
import {
	HILINK_CONNECTION_PATH,
	HILINK_DHCP_SETTINGS_PATH,
	HILINK_NET_MODE_PATH,
	HILINK_SESSION_PATH,
} from "../modules/network/hilink-session.ts";
import {
	netdevPresence,
	noteNetdevWitness,
	resetNetdevLifetimesForTest,
} from "../modules/network/netdev-lifetime.ts";
import type { RouterAdminProbeDeps } from "../modules/network/router-cellular-admin.ts";
import {
	applyRouterCellularControl,
	applyRouterNetMode,
} from "../modules/network/router-cellular-control.ts";
import {
	defaultSubnetRewriteDeps,
	executeSubnetRewrite,
	prepareSubnetRewrite,
} from "../modules/network/router-subnet-hygiene.ts";
import {
	type HilinkDhcpRecord,
	parseHilinkDhcpSettings,
} from "../modules/network/router-subnet-plan.ts";

const IFNAME = "enx0c5b8f279a64";
const HILINK = "12d1:14dc";
const SESSION =
	"<response><SesInfo>cookie</SesInfo><TokInfo>token</TokInfo></response>";
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
const TARGET = "192.168.9.1";

function lifetime() {
	const link = { index: 7 };
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockImplementation(() => link.index);
	noteNetdevWitness(IFNAME, { ifindex: 7, present: true });
	return {
		swap: () => {
			link.index = 17;
		},
		owner: () => link.index,
	};
}

test("a partial issuing read cannot forget the known node when the ifindex is reused", async () => {
	const before = fs.statSync(import.meta.dir, { bigint: true });
	const after = fs.statSync(import.meta.path, { bigint: true });
	spyOn(netdevPresence, "inSysfs").mockReturnValue(true);
	spyOn(netdevPresence, "ifindex").mockReturnValue(7);
	noteNetdevWitness(IFNAME, {
		node: `${before.dev}:${before.ino}`,
		ifindex: 7,
		present: true,
	});
	const node = spyOn(fs, "statSync").mockImplementation(() => {
		throw Object.assign(new Error("cannot read node at issue"), {
			code: "EIO",
		});
	});
	let written = false;
	const deps: RouterAdminProbeDeps = {
		isRealDevice: async () => true,
		runIpRouteShowDefault: async () =>
			`default via ${FACTORY.address} dev ${IFNAME}`,
		fetchViaInterface: async (_name, urls) => {
			node.mockReturnValue(after);
			return urls.map((url) =>
				url.endsWith(HILINK_SESSION_PATH)
					? SESSION
					: url.endsWith(HILINK_CONNECTION_PATH)
						? "<response><RoamAutoConnectEnable>0</RoamAutoConnectEnable></response>"
						: `<response><dataswitch>${written ? 1 : 0}</dataswitch></response>`,
			);
		},
		postViaInterface: async () => {
			written = true;
			return "<response>OK</response>";
		},
	};
	expect(
		(
			await applyRouterCellularControl(
				IFNAME,
				HILINK,
				"mobile_data",
				true,
				deps,
			)
		).status,
	).toBe("refused");
	expect(written).toBe(false);
});

afterEach(() => {
	jest.restoreAllMocks();
	resetNetdevLifetimesForTest();
});

for (const path of [
	"mobile_data",
	"roaming_autoconnect",
	"net_mode",
] as const) {
	for (const swapAt of [
		"write input",
		"before post",
		"read-back",
		"never",
	] as const) {
		test(`${path}: same-name replacement at ${swapAt}`, async () => {
			const link = lifetime();
			const posts: number[] = [];
			let written = false;
			let sessions = 0;
			const deps: RouterAdminProbeDeps = {
				isRealDevice: async () => true,
				runIpRouteShowDefault: async () =>
					`default via ${FACTORY.address} dev ${IFNAME}`,
				fetchViaInterface: async (_name, urls) => {
					if (urls[0]?.endsWith(HILINK_SESSION_PATH)) sessions++;
					const value = urls.map((url) => {
						if (url.endsWith(HILINK_SESSION_PATH)) return SESSION;
						if (url.endsWith(HILINK_CONNECTION_PATH))
							return `<response><RoamAutoConnectEnable>${written ? 1 : 0}</RoamAutoConnectEnable></response>`;
						if (url.endsWith(HILINK_NET_MODE_PATH))
							return `<response><NetworkMode>${written ? "03" : "00"}</NetworkMode></response>`;
						if (url.endsWith("/net-mode-list"))
							return "<response><NetworkModeList><NetworkMode><Index>03</Index><Name>LTE</Name></NetworkMode></NetworkModeList></response>";
						return `<response><dataswitch>${written ? 1 : 0}</dataswitch></response>`;
					});
					const session = urls[0]?.endsWith(HILINK_SESSION_PATH);
					const writeInput =
						sessions === 1 && Boolean(session) === (path === "mobile_data");
					if (writeInput && swapAt === "before post") {
						queueMicrotask(() => queueMicrotask(link.swap));
					} else if (
						(writeInput && swapAt === "write input") ||
						(swapAt === "read-back" && sessions === 2 && !session)
					)
						link.swap();
					return value;
				},
				postViaInterface: async () => {
					posts.push(link.owner());
					written = true;
					return "<response>OK</response>";
				},
			};
			const outcome =
				path === "net_mode"
					? await applyRouterNetMode(IFNAME, HILINK, "03", deps)
					: await applyRouterCellularControl(IFNAME, HILINK, path, true, deps);
			expect(posts).toEqual(
				swapAt === "write input" || swapAt === "before post" ? [] : [7],
			);
			expect(outcome.status).toBe(swapAt === "never" ? "applied" : "refused");
		});
	}
}

for (const swapAt of [
	"write session",
	"write reply",
	"disconnect",
	"rollback",
	"never",
] as const) {
	test(`subnet: same-name replacement at ${swapAt}`, async () => {
		const link = lifetime();
		const posts: number[] = [];
		const commands: Array<[string | undefined, number]> = [];
		let record = FACTORY;
		let oldSessions = 0;
		let newSessions = 0;
		spyOn(runner, "run").mockImplementation(async (bin, argv) => {
			if (bin !== "nmcli") throw new Error(`unexpected command: ${bin}`);
			commands.push([argv[1], link.owner()]);
			if (swapAt === "disconnect" && argv[1] === "disconnect") link.swap();
			return "";
		});
		const deps = {
			...defaultSubnetRewriteDeps,
			isRealDevice: async () => true,
			runIpRouteShowDefault: async () =>
				`default via ${FACTORY.address} dev ${IFNAME}`,
			runIpAddrShow: async () => "",
			wait: async () => {},
			fetchViaInterface: async (_name: string, urls: readonly string[]) =>
				urls.map((url) => {
					const host = new URL(url).hostname;
					if (url.endsWith(HILINK_SESSION_PATH)) {
						if (
							host === FACTORY.address &&
							++oldSessions === 3 &&
							swapAt === "write session"
						)
							link.swap();
						if (host === TARGET && swapAt === "rollback") {
							newSessions++;
							if (newSessions <= 6) return "";
							if (newSessions === 8) link.swap();
						}
						return host === record.address ? SESSION : "";
					}
					if (
						!url.endsWith(HILINK_DHCP_SETTINGS_PATH) ||
						host !== record.address
					)
						return "";
					return hilinkDhcpSettingsBody(record)
						.replace("<request>", "<response>")
						.replace("</request>", "</response>");
				}),
			postViaInterface: async (_name: string, _url: string, body: string) => {
				posts.push(link.owner());
				record =
					parseHilinkDhcpSettings(
						body
							.replace("<request>", "<response>")
							.replace("</request>", "</response>"),
					) ?? record;
				if (swapAt === "write reply") link.swap();
				return "<response>OK</response>";
			},
		};
		const prepared = await prepareSubnetRewrite(IFNAME, HILINK, TARGET, deps);
		if (!prepared.ok) throw new Error(`preflight: ${prepared.reason}`);
		const outcome = await executeSubnetRewrite(
			prepared.plan,
			async () => {},
			deps,
		);
		expect(posts).toEqual(swapAt === "write session" ? [] : [7]);
		expect(commands.filter(([, owner]) => owner !== 7)).toEqual([]);
		if (swapAt === "disconnect") expect(commands).toEqual([["disconnect", 7]]);
		if (swapAt === "write reply") expect(commands).toEqual([]);
		expect(outcome.status).toBe(
			swapAt === "never"
				? "applied"
				: swapAt === "write session"
					? "refused"
					: "blocked",
		);
	});
}
