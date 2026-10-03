import { join } from "node:path";

const [phase, root, address, index] = process.argv.slice(2);
if (!root) throw new Error("fixture root missing");

if (phase === "server") {
	if (!address || !index) throw new Error("fixture peer missing");
	Bun.serve({
		hostname: address,
		port: 8088,
		fetch: () => {
			if (index === "1") return new Response("SECOND_UPLINK");
			return new Response(
				new ReadableStream({
					start(controller) {
						controller.enqueue(new TextEncoder().encode("FIRST_UPLINK"));
						void Bun.write(join(root, "started"), "first chunk sent");
					},
					pull: () => Bun.sleep(120_000),
				}),
				{ headers: { "Content-Length": "100000" } },
			);
		},
	});
	await Bun.sleep(120_000);
} else if (phase === "client") {
	const file = join(root, "update-capabilities.json");
	const uid = 42042;
	await Bun.write(
		file,
		JSON.stringify({
			schema: 1,
			features: ["apt-all-packages", "transport-uidrange"],
			apt_uid: uid,
			ota_uid: 42043,
		}),
	);
	const { SETUP_CONFIG_DEFAULTS } = await import(
		"../../helpers/config-schemas.ts"
	);
	await Bun.write(
		join(root, "setup.json"),
		JSON.stringify(SETUP_CONFIG_DEFAULTS),
	);
	process.chdir(root);
	const { spawnWithTimeout } = await import("../../helpers/spawn-policy.ts");
	const { readUpdateCapabilityFile } = await import(
		"../../modules/system/update-capabilities.ts"
	);
	const { rankTransports } = await import(
		"../../modules/system/update-transport/core.ts"
	);
	const {
		createUpdatePinController,
		UPDATE_TRANSPORT_TABLE_BASE,
		UpdateTransferError,
	} = await import("../../modules/system/update-transport/pin.ts");
	const ip = async (args: string[]): Promise<string> => {
		const result = await spawnWithTimeout(["ip", ...args], {
			timeoutMs: 5_000,
		});
		if (result.exitCode !== 0)
			throw new Error(`ip ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout;
	};
	const rules = async (label: string): Promise<void> => {
		process.stdout.write(
			`${label} IPv4 rules:\n${await ip(["rule", "show"])}${label} IPv6 rules:\n${await ip(["-6", "rule", "show"])}`,
		);
	};
	const controller = createUpdatePinController({
		readCapabilities: () => readUpdateCapabilityFile(file),
	});
	await controller.sweep();
	const chosen = rankTransports(
		["eth0", "eth1"].map((ifname, rank) => ({
			candidate: { ifname, kind: "ethernet" as const, metered: rank === 1 },
			family: 4 as const,
			hosts: [{ host: "fixture", state: "clear" as const, latencyMs: rank }],
		})),
	);
	const attempts: string[] = [];
	const result = await controller.run(
		"apt",
		chosen,
		async ({ candidate }, flags) => {
			attempts.push(candidate.ifname);
			if (flags.join(" ") !== "-o Acquire::ForceIPv4=true")
				throw new Error("apt family flag missing");
			await rules(`DURING_${candidate.ifname}`);
			const destination =
				candidate.ifname === "eth0" ? "192.0.2.2" : "198.51.100.2";
			process.stdout.write(
				`UID route: ${await ip(["route", "get", destination, "uid", String(uid)])}`,
			);
			const own = Bun.spawn(
				[
					"setpriv",
					"--reuid",
					String(uid),
					"--regid",
					String(uid),
					"--clear-groups",
					"curl",
					"--noproxy",
					"*",
					"--max-time",
					"5",
					"-sS",
					`http://${destination}:8088/`,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const body = new Response(own.stdout).text();
			const err = new Response(own.stderr).text();
			if (candidate.ifname === "eth0") {
				const until = Date.now() + 4000;
				while (
					!(await Bun.file(join(root, "started")).exists()) &&
					Date.now() < until
				)
					await Bun.sleep(20);
				if (!(await Bun.file(join(root, "started")).exists())) {
					own.kill();
					throw new Error(
						`first uplink never began transfer: curl=${await own.exited} stdout=${await body} stderr=${await err}`,
					);
				}
				const other = Bun.spawn(
					[
						"setpriv",
						"--reuid",
						String(uid),
						"--regid",
						String(uid),
						"--clear-groups",
						"curl",
						"--noproxy",
						"*",
						"--connect-timeout",
						"1",
						"--max-time",
						"2",
						"-sS",
						"http://198.51.100.2:8088/",
					],
					{ stdout: "pipe", stderr: "pipe" },
				);
				const otherOut = new Response(other.stdout).text();
				const otherErr = new Response(other.stderr).text();
				if ((await other.exited) === 0)
					throw new Error(`unpinned uplink leaked to UID: ${await otherOut}`);
				await otherErr;
				process.stdout.write("OTHER_UPLINK_UNREACHABLE=PASS\n");
				await ip(["link", "set", "eth0", "down"]);
				const afterDrop = await spawnWithTimeout(
					["ip", "route", "get", "198.51.100.2", "uid", String(uid)],
					{ timeoutMs: 5_000 },
				);
				if (afterDrop.exitCode === 0)
					throw new Error(
						`main table leaked after link loss: ${afterDrop.stdout}`,
					);
				process.stdout.write("NO_FALLTHROUGH_AFTER_LINK_DROP=PASS\n");
			}
			const exit = await own.exited;
			const text = await body;
			await err;
			if (exit !== 0) throw new UpdateTransferError("blocked");
			return text;
		},
	);
	if (
		result !== "SECOND_UPLINK" ||
		attempts.join(",") !== "eth0,eth1" ||
		!controller.unhealthyUntil("eth0", 4)
	)
		throw new Error(`failover mismatch: ${result} ${attempts}`);
	process.stdout.write("MID_TRANSFER_FAILOVER=PASS\n");
	await rules("AFTER_TRANSACTION");
	if (
		(await ip(["rule", "show"])).includes("120:") ||
		(await ip(["-6", "rule", "show"])).includes("120:")
	)
		throw new Error("transaction leaked rules");
	process.stdout.write("NO_LEAKED_RULES=PASS\n");
	// Simulate SIGKILL after rule installation: no finally is run for these rules.
	await ip([
		"route",
		"add",
		"default",
		"via",
		"198.51.100.2",
		"dev",
		"eth1",
		"table",
		String(UPDATE_TRANSPORT_TABLE_BASE),
	]);
	await ip([
		"rule",
		"add",
		"priority",
		"120",
		"uidrange",
		`${uid}-${uid}`,
		"lookup",
		String(UPDATE_TRANSPORT_TABLE_BASE),
	]);
	await ip([
		"-6",
		"rule",
		"add",
		"priority",
		"120",
		"uidrange",
		`${uid}-${uid}`,
		"prohibit",
	]);
	await rules("CRASH_LEFTOVERS");
	await controller.sweep();
	await rules("AFTER_STARTUP_SWEEP");
	if (
		(await ip(["rule", "show"])).includes("120:") ||
		(await ip(["-6", "rule", "show"])).includes("120:") ||
		(
			await ip(["route", "show", "table", String(UPDATE_TRANSPORT_TABLE_BASE)])
		).trim()
	)
		throw new Error("sweep left stale routing state");
	process.stdout.write("CRASH_RECOVERY_SWEEP=PASS\n");
} else throw new Error("unknown fixture phase");
