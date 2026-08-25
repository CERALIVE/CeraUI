import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { buildShaperPlan } from "../modules/network/uplink-shaper/plan.ts";
import {
	buildShareRuleset,
	stableUplinkMark,
} from "../modules/network/uplink-steering/index.ts";

test("kernel netns classifies client fwmarks into capped band while local traffic stays uncapped", async () => {
	const mark = stableUplinkMark("wan-a");
	const root = join(process.cwd(), "test-results", "uplink-sharing");
	await mkdir(root, { recursive: true });
	const temp = await mkdtemp(join(root, "shaper-netns-"));
	try {
		const rulesetPath = join(temp, "share.nft");
		const commandsPath = join(temp, "commands.json");
		await writeFile(
			rulesetPath,
			buildShareRuleset({
				clientZones: [{ ifname: "client0", ipv4Cidr: "10.42.0.0/24" }],
				uplinks: [
					{
						identity: "wan-a",
						ifname: "wan0",
						mark,
						selectable: true,
						weight: 100,
					},
				],
			}),
		);
		await writeFile(
			commandsPath,
			JSON.stringify(
				buildShaperPlan({
					mode: "streaming",
					cakeAvailable: false,
					uplinks: [{ ifname: "wan0", mark, capBps: 10_000_000 }],
				}).map((command) => command.argv),
			),
		);
		const privilege = await netnsPrivilegePrefix();
		const proc = Bun.spawn(
			[
				...privilege,
				"unshare",
				"-rn",
				"bash",
				fileURLToPath(
					new URL("./fixtures/uplink-shaper-netns.sh", import.meta.url),
				),
				rulesetPath,
				commandsPath,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode, stderr).toBe(0);
		const result = JSON.parse(stdout.trim()) as {
			readonly localPackets: number;
			readonly clientPackets: number;
		};
		expect(result.localPackets).toBeGreaterThan(0);
		expect(result.clientPackets).toBeGreaterThan(0);
	} finally {
		await rm(temp, { recursive: true, force: true });
	}
}, 20_000);

async function netnsPrivilegePrefix(): Promise<readonly string[]> {
	const direct = Bun.spawn(["unshare", "-rn", "true"], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const directError = new Response(direct.stderr).text();
	if ((await direct.exited) === 0) return [];
	const elevated = Bun.spawn(["sudo", "-n", "unshare", "-rn", "true"], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const elevatedError = new Response(elevated.stderr).text();
	if ((await elevated.exited) === 0) return ["sudo", "-n"];
	throw new Error(
		`network namespaces unavailable: direct=${(await directError).trim()} sudo=${(await elevatedError).trim()}`,
	);
}
