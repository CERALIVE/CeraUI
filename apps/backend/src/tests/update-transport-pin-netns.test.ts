import { describe, expect, test } from "bun:test";
import { netnsPrivilegePrefix } from "./helpers/netns-privilege.ts";

describe.skipIf(process.env.CERALIVE_NETNS_ISOLATED !== "1")(
	"update pin — two real veth uplinks",
	() => {
		test("TEST UID cannot escape, transfer fails over and startup sweeps crashed rules", async () => {
			const script = `${import.meta.dir}/fixtures/update-transport-netns.sh`;
			const prefix = await netnsPrivilegePrefix(script);
			const child = Bun.spawn(
				[
					...prefix,
					"unshare",
					process.getuid?.() === 0 ? "-n" : "-rn",
					"bash",
					script,
					"pin",
					process.execPath,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			if (process.env.CERALIVE_PIN_EVIDENCE)
				await Bun.write(
					process.env.CERALIVE_PIN_EVIDENCE,
					`${stdout}\nSTDERR:\n${stderr}\nEXIT=${exit}\n`,
				);
			expect(exit, `${stdout}\n${stderr}`).toBe(0);
			for (const label of [
				"OTHER_UPLINK_UNREACHABLE",
				"MID_TRANSFER_FAILOVER",
				"NO_LEAKED_RULES",
				"CRASH_RECOVERY_SWEEP",
			])
				expect(stdout).toContain(`${label}=PASS`);
			expect(stdout).toContain("DURING_eth0 IPv4 rules:");
			expect(stdout).toContain("AFTER_STARTUP_SWEEP IPv6 rules:");
		}, 120_000);
	},
);
