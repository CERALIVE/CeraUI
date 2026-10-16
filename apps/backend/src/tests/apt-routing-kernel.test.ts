import { expect, test } from "bun:test";
import { readlink } from "node:fs/promises";

const setup = `
set -eu
test "$(readlink /proc/self/ns/net)" != "$APT_PIN_HOST_NETNS"
test "$(id -u)" = 0
ip link set lo up
ip link add eth0 type dummy
ip link set eth0 up
ip addr add 192.0.2.2/24 dev eth0
ip route add default via 192.0.2.1 dev eth0
ip -6 addr add 2001:db8::2/64 dev eth0 nodad
ip -6 route add default via 2001:db8::1 dev eth0
exec "$@"
`;

test.each(["K0", "K1", "K2", "K3"])(
	"kernel %s: APT routing lifetime",
	async (name) => {
		// Given one fresh unprivileged user/network namespace per kernel case.
		if (process.env.APT_PIN_KERNEL_CHILD === name) {
			expect(await readlink("/proc/self/ns/net")).not.toBe(
				process.env.APT_PIN_HOST_NETNS,
			);
			expect(await Bun.file("/proc/self/uid_map").text()).toMatch(
				/^\s*1\s+100000\s+65536\s*$/m,
			);
			const { kernelCase } = await import(
				"./helpers/apt-routing-kernel-cases.ts"
			);
			await kernelCase(name);
			return;
		}
		// When the real adapter runs in that namespace, never on host routing.
		const child = Bun.spawn(
			[
				"unshare",
				"--map-root-user",
				"--map-users=1:100000:65536",
				"-n",
				"bash",
				"-c",
				setup,
				"apt-kernel",
				process.execPath,
				"test",
				import.meta.path,
				"-t",
				`kernel ${name}:`,
			],
			{
				cwd: new URL("../..", import.meta.url).pathname,
				env: {
					...process.env,
					APT_PIN_KERNEL_CHILD: name,
					APT_PIN_HOST_NETNS: await readlink("/proc/self/ns/net"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		process.stdout.write(stdout + stderr);
		// Then the production kernel case succeeds, including its pin/cleanup assertions.
		expect(code).toBe(0);
	},
	30_000,
);
