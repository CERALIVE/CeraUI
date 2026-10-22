import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	netnsPrivilegePrefix,
	netnsUnshareFlag,
} from "./helpers/netns-privilege.ts";

test("transport fixture waits for delayed peer namespaces and listeners", async () => {
	// Given real namespaces whose creation is deliberately delayed behind the parent.
	const root = await mkdtemp(join(tmpdir(), "transport-readiness-"));
	try {
		const unshare = Bun.which("unshare");
		const ip = Bun.which("ip");
		expect(unshare).not.toBeNull();
		expect(ip).not.toBeNull();
		await Bun.write(
			join(root, "unshare"),
			`#!/bin/bash
sleep 0.2
exec ${JSON.stringify(unshare)} "$@"
`,
		);
		await Bun.write(
			join(root, "ip"),
			`#!/bin/bash
set -euo pipefail
${JSON.stringify(ip)} "$@"
if [[ "$*" == "link set srv"*" netns "* ]]; then
  peer="\${!#}"
  for ((i=0; i<500; i++)); do
    [[ "$(readlink /proc/$peer/ns/net)" != "$(readlink /proc/self/ns/net)" ]] && exit 0
    sleep 0.01
  done
  exit 1
fi
`,
		);
		const bun = join(root, "fixture-bun");
		await Bun.write(
			bun,
			`#!/bin/bash
set -euo pipefail
if [ "$2" = server ]; then
  sleep 0.6
  touch "$3/server-$5.ready"
  exec ${JSON.stringify(process.execPath)} -e 'Bun.serve({hostname:process.argv[1],port:8088,fetch:()=>new Response("ready")}); await Bun.sleep(120000)' "$4"
fi
test -f "$3/server-0.ready"
test -f "$3/server-1.ready"
echo READY_CLIENT=PASS
`,
		);
		for (const file of ["unshare", "ip", "fixture-bun"])
			await chmod(join(root, file), 0o755);
		const script = join(import.meta.dir, "fixtures/update-transport-netns.sh");
		const prefix = await netnsPrivilegePrefix(script);
		// When the actual shell fixture creates its two veths and starts the client.
		await using child = Bun.spawn(
			[
				...prefix,
				"unshare",
				netnsUnshareFlag(prefix),
				"bash",
				script,
				"pin",
				bun,
			],
			{
				env: { ...process.env, PATH: `${root}:${process.env.PATH}` },
				timeout: 15_000,
				killSignal: "SIGKILL",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [exit, stdout, stderr] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		// Then both transfers and delayed listener publications preceded the client.
		expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
		expect(stdout).toContain("READY_CLIENT=PASS");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);
