import { expect, test } from "bun:test";
import { readlink } from "node:fs/promises";
import { aptKernelTestAvailability } from "./helpers/apt-routing-kernel-probe.ts";
import { runTestCommand } from "./helpers/run-test-command.ts";

// Probe the id mapping too: plain -Urn support does not grant a subuid range.
// Children already hold the required namespace and must not probe a nested one.
const { available, suffix } = aptKernelTestAvailability(
	process.env.APT_PIN_KERNEL_CHILD
		? { code: 0, stderr: "" }
		: await runTestCommand([
				"unshare",
				"--map-root-user",
				"--map-users=1:100000:65536",
				"-n",
				"true",
			]),
);

test("APT kernel cases skip with the probe reason when id mapping is refused", () => {
	// Given an unavailable id-map namespace facility.
	const probe = { code: 1, stderr: "  newuidmap: Operation not permitted\n" };
	// When test registration interprets the failed probe.
	const decision = aptKernelTestAvailability(probe);
	// Then the cases are skipped with a visible, trimmed diagnostic.
	expect(decision).toEqual({
		available: false,
		suffix:
			" (SKIP: user/network namespace with id maps unavailable: newuidmap: Operation not permitted)",
	});
});

test("APT kernel cases run when the exact id-map namespace probe succeeds", () => {
	// Given a successful probe, even if the tool wrote a warning.
	const probe = { code: 0, stderr: "namespace warning\n" };
	// When test registration interprets that probe.
	const decision = aptKernelTestAvailability(probe);
	// Then all cases remain runnable under their unchanged titles.
	expect(decision).toEqual({ available: true, suffix: "" });
});

const setup = `
set -eu
test "$(readlink /proc/self/ns/net)" != "$APT_PIN_HOST_NETNS"
test "$(id -u)" = 0
ip link set lo up
if [ "$APT_PIN_KERNEL_CHILD" = A2 ]; then exec "$@"; fi
ip link add eth0 type dummy
ip link set eth0 up
ip addr add 192.0.2.2/24 dev eth0
ip route add default via 192.0.2.1 dev eth0
ip -6 addr add 2001:db8::2/64 dev eth0 nodad
ip -6 route add default via 2001:db8::1 dev eth0
if [ "$APT_PIN_KERNEL_CHILD" = A3 ]; then
  ip link add eth1 type dummy
  ip link set eth1 up
  ip addr add 198.51.100.2/24 dev eth1
  ip route add default via 198.51.100.1 dev eth1 metric 50
fi
exec "$@"
`;

(available ? test : test.skip).each(["K0", "K1", "K2", "K3", "A1", "A2", "A3"])(
	`kernel %s: APT routing lifetime${suffix}`,
	async (name) => {
		// Given one fresh unprivileged user/network namespace per kernel case.
		if (process.env.APT_PIN_KERNEL_CHILD === name) {
			expect(await readlink("/proc/self/ns/net")).not.toBe(
				process.env.APT_PIN_HOST_NETNS,
			);
			expect(await Bun.file("/proc/self/uid_map").text()).toMatch(
				/^\s*1\s+100000\s+65536\s*$/m,
			);
			if (name.startsWith("A")) {
				const { vanishedDeviceCase } = await import(
					"./helpers/apt-routing-vanished-device-cases.ts"
				);
				await vanishedDeviceCase(name);
			} else {
				const { kernelCase } = await import(
					"./helpers/apt-routing-kernel-cases.ts"
				);
				await kernelCase(name);
			}
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
