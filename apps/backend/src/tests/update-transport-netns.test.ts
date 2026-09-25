import { describe, expect, test } from "bun:test";
import {
	netnsPrivilegePrefix,
	netnsUnshareFlag,
} from "./helpers/netns-privilege.ts";

describe.skipIf(process.env.CERALIVE_NETNS_ISOLATED !== "1")(
	"update transport — real device-bound sockets in network namespaces",
	() => {
		test("healthy, HTTP 302, untrusted TLS, IPv6 blackhole, DNS hijack, metered competing uplink", async () => {
			const script = `${import.meta.dir}/fixtures/update-transport-netns.sh`;
			const prefix = await netnsPrivilegePrefix(script);
			const process = Bun.spawn(
				[...prefix, "unshare", netnsUnshareFlag(prefix), "bash", script],
				{
					stdout: "pipe",
					stderr: "pipe",
				},
			);
			const [stdout, stderr, exit] = await Promise.all([
				new Response(process.stdout).text(),
				new Response(process.stderr).text(),
				process.exited,
			]);
			expect(exit, `${stdout}\n${stderr}`).toBe(0);
			for (const label of [
				"HEALTHY_APT",
				"HEALTHY_OS",
				"HTTP_302",
				"SELF_SIGNED_PORTAL",
				"V6_BLACKHOLE",
				"DNS_HIJACK",
				"TAMPERED_INDEX",
				"TWO_UPLINKS_METERED",
			])
				expect(stdout).toContain(`${label}=PASS`);
		}, 120_000);
	},
);
