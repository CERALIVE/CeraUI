import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { spawnWithTimeout } from "../../helpers/spawn-policy.ts";

const [phase, root, address, index] = process.argv.slice(2);
if (!root) throw new Error("fixture directory required");

async function command(
	argv: string[],
	env?: Record<string, string>,
): Promise<string> {
	const result = await spawnWithTimeout(argv, {
		timeoutMs: 30_000,
		...(env ? { env: { ...process.env, ...env } } : {}),
	});
	if (result.exitCode !== 0)
		throw new Error(
			`${argv[0]} failed with ${result.exitCode}: ${result.stderr}`,
		);
	return result.stdout;
}

if (phase === "prepare") {
	for (const suffix of ["trusted", "portal"]) {
		await command([
			"openssl",
			"req",
			"-x509",
			"-newkey",
			"rsa:2048",
			"-nodes",
			"-keyout",
			join(root, `${suffix}.key`),
			"-out",
			join(root, `${suffix}.crt`),
			"-days",
			"1",
			"-subj",
			"/CN=apt.ceralive.tv",
			"-addext",
			"subjectAltName=DNS:apt.ceralive.tv,DNS:images.ceralive.tv,DNS:deb.debian.org",
		]);
	}
	const home = join(root, "gnupg");
	await mkdir(home, { mode: 0o700 });
	await command(
		[
			"gpg",
			"--batch",
			"--pinentry-mode",
			"loopback",
			"--passphrase",
			"",
			"--quick-generate-key",
			"CeraLive Fixture <fixture@example.test>",
			"default",
			"default",
			"0",
		],
		{ GNUPGHOME: home },
	);
	await writeFile(
		join(root, "release-plain"),
		"Origin: Debian\nSuite: trixie\nDate: Thu, 24 Sep 2026 00:00:00 UTC\n",
	);
	await command(
		[
			"gpg",
			"--batch",
			"--yes",
			"--clearsign",
			"--output",
			join(root, "InRelease"),
			join(root, "release-plain"),
		],
		{ GNUPGHOME: home },
	);
	const exported = Bun.spawn(
		["gpg", "--batch", "--export", "CeraLive Fixture"],
		{
			env: { ...process.env, GNUPGHOME: home },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const bytes = await new Response(exported.stdout).arrayBuffer();
	if ((await exported.exited) !== 0)
		throw new Error("fixture key export failed");
	await Bun.write(join(root, "debian.gpg"), bytes);
	await Bun.write(join(root, "mode"), "healthy");
} else if (phase === "server") {
	if (!address || !index)
		throw new Error("fixture listener requires address and index");
	const suffix = index === "0" ? "trusted" : "portal";
	const respond = async (request: Request): Promise<Response> => {
		const url = new URL(request.url);
		const mode = (await Bun.file(join(root, "mode")).text()).trim();
		if (url.pathname === "/generate_204")
			return mode === "portal" || mode === "selfsigned"
				? new Response(null, {
						status: 302,
						headers: { Location: "http://portal.example.test/login" },
					})
				: new Response(null, { status: 204 });
		if (url.pathname === "/__tls-probe")
			return Response.json({ certPresented: true, certVerified: true });
		if (url.pathname === "/debian/dists/trixie/InRelease")
			return mode === "tampered"
				? new Response("altered unsigned index")
				: new Response(Bun.file(join(root, "InRelease")));
		if (url.pathname === "/channels/stable/rock-5b-plus.json.sig")
			return new Response(null, { status: 200 });
		return new Response(null, { status: 404 });
	};
	Bun.serve({ hostname: address, port: 80, fetch: respond });
	Bun.serve({
		hostname: address,
		port: 443,
		tls: {
			key: Bun.file(join(root, `${suffix}.key`)),
			cert: Bun.file(join(root, `${suffix}.crt`)),
		},
		fetch: respond,
	});
	if (index === "0") {
		Bun.serve({ hostname: "192.0.2.3", port: 80, fetch: respond });
		Bun.serve({
			hostname: "192.0.2.3",
			port: 443,
			tls: {
				key: Bun.file(join(root, "portal.key")),
				cert: Bun.file(join(root, "portal.crt")),
			},
			fetch: respond,
		});
	}
	await Bun.sleep(120_000);
} else if (phase === "client") {
	const { SETUP_CONFIG_DEFAULTS } = await import(
		"../../helpers/config-schemas.ts"
	);
	await Bun.write(
		join(root, "setup.json"),
		JSON.stringify(SETUP_CONFIG_DEFAULTS),
	);
	process.chdir(root);
	const { selectUpdateTransport } = await import(
		"../../modules/system/update-transport/executor.ts"
	);
	let mode = "healthy";
	let resolverCount = 0;
	let two = false;
	const select = (profile: "apt" | "os") =>
		selectUpdateTransport(
			{ profile, channel: "stable", board: "rock-5b-plus" },
			{
				listIfnames: () => (two ? ["eth0", "eth1"] : ["eth0"]),
				readSources: async () =>
					`Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nSigned-By: ${join(root, "debian.gpg")}`,
				credentials: async () => ({
					cert: join(root, "trusted.crt"),
					key: join(root, "trusted.key"),
				}),
				mmIfnames: () => [],
				routerIfnames: () => [],
				dongleIfnames: () => [],
				run: async (argv) => {
					if (argv[0] === "nmcli")
						return {
							exitCode: 0,
							stdout: `GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no\n${two ? "\nGENERAL.DEVICE:eth1\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:yes\n" : ""}`,
							stderr: "",
						};
					if (argv[0] === "resolvectl") {
						const host = argv.at(-1) ?? "";
						if (argv.includes("-6"))
							return {
								exitCode: 0,
								stdout: `${host}: 2001:db8:1::2`,
								stderr: "",
							};
						const ifname = argv[argv.indexOf("-i") + 1];
						const hijack =
							host === "apt.ceralive.tv" &&
							(mode === "hijack" ||
								(mode === "selfsigned" && ++resolverCount % 2 === 0));
						return {
							exitCode: 0,
							stdout: `${host}: ${ifname === "eth1" ? "198.51.100.2" : hijack ? "192.0.2.3" : "192.0.2.2"}`,
							stderr: "",
						};
					}
					if (argv[0] === "openssl")
						return spawnWithTimeout(argv, { timeoutMs: 4_500 });
					if (argv[0] === "curl") {
						const target = argv.at(-1) ?? "";
						if (argv.includes("-6"))
							return { exitCode: 28, stdout: "", stderr: "" };
						const certificate =
							mode === "metered" && argv.includes("if!eth1")
								? "portal.crt"
								: "trusted.crt";
						return spawnWithTimeout(
							[
								argv[0],
								...argv.slice(1, -1),
								...(target.startsWith("https:")
									? ["--cacert", join(root, certificate)]
									: []),
								target,
							],
							{ timeoutMs: 4_500 },
						);
					}
					return spawnWithTimeout(argv, { timeoutMs: 4_500 });
				},
			},
		);
	const assert = (label: string, condition: boolean): void => {
		if (!condition) throw new Error(`${label} failed`);
		process.stdout.write(`${label}=PASS\n`);
	};
	const healthyApt = await select("apt");
	const healthyOs = await select("os");
	assert(
		"HEALTHY_APT",
		healthyApt.status === "selected" &&
			healthyApt.selected.family === 4 &&
			healthyApt.selected.hosts.every((host) => host.state === "clear"),
	);
	assert(
		"HEALTHY_OS",
		healthyOs.status === "selected" &&
			healthyOs.selected.hosts.every((host) => host.state === "clear"),
	);
	await Bun.write(join(root, "mode"), "portal");
	mode = "portal";
	const portal = await select("os");
	assert(
		"HTTP_302",
		portal.status === "none" &&
			portal.ranked.some((row) =>
				row.hosts.some((host) => host.state === "captive-http"),
			),
	);
	await Bun.write(join(root, "mode"), "selfsigned");
	mode = "selfsigned";
	resolverCount = 0;
	const tlsPortal = await select("apt");
	assert(
		"SELF_SIGNED_PORTAL",
		tlsPortal.status === "none" &&
			tlsPortal.ranked.some((row) =>
				row.hosts.some((host) => host.state === "captive-tls"),
			),
	);
	await Bun.write(join(root, "mode"), "healthy");
	mode = "healthy";
	const v6 = await select("os");
	assert(
		"V6_BLACKHOLE",
		v6.status === "selected" &&
			v6.selected.family === 4 &&
			v6.ranked.some(
				(row) =>
					row.family === 6 &&
					row.hosts.some((host) => host.state === "blocked"),
			),
	);
	mode = "hijack";
	const hijack = await select("apt");
	assert(
		"DNS_HIJACK",
		hijack.status === "none" &&
			hijack.ranked.some((row) =>
				row.hosts.some((host) => host.state === "tls-error"),
			),
	);
	mode = "tampered";
	await Bun.write(join(root, "mode"), "tampered");
	const tampered = await select("apt");
	assert(
		"TAMPERED_INDEX",
		tampered.status === "none" &&
			tampered.ranked.some((row) =>
				row.hosts.some((host) => host.state === "tampered"),
			),
	);
	mode = "metered";
	await Bun.write(join(root, "mode"), "metered");
	two = true;
	const metered = await select("os");
	assert(
		"TWO_UPLINKS_METERED",
		metered.status === "selected" &&
			metered.selected.candidate.ifname === "eth0" &&
			metered.ranked.some(
				(row) => row.candidate.ifname === "eth1" && row.healthy,
			),
	);
	process.stdout.write(
		"CLASSIFICATIONS captive-http captive-tls tls-error IPv6 blocked; v4 selected\n",
	);
} else throw new Error("unknown fixture phase");
