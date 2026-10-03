import { expect, test } from "bun:test";
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";

test("APT and OS profiles probe only their configured hosts, on both families, bound to the device", async () => {
	const calls: string[][] = [];
	const selection = async (profile: "apt" | "os") =>
		selectUpdateTransport(
			{ profile, board: "rock-5b-plus", channel: "stable" },
			{
				listIfnames: () => ["eth0"],
				readSources: async () =>
					"Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nSigned-By: /tmp/debian.gpg",
				credentials: async () => ({
					cert: "/tmp/client.crt",
					key: "/tmp/client.key",
				}),
				run: async (argv) => {
					calls.push(argv);
					if (argv[0] === "nmcli")
						return {
							exitCode: 0,
							stdout:
								"GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)",
							stderr: "",
						};
					if (argv[0] === "resolvectl")
						return {
							exitCode: 0,
							stdout: `${argv.at(-1)}: ${argv.includes("-6") ? "2001:db8::1" : "192.0.2.1"}`,
							stderr: "",
						};
					if (argv[0] === "gpgv" || argv[0] === "openssl")
						return { exitCode: 0, stdout: "", stderr: "" };
					if (argv.includes("-6"))
						return { exitCode: 28, stdout: "", stderr: "" };
					const url = argv.at(-1) ?? "";
					if (url.endsWith("/__tls-probe"))
						return {
							exitCode: 0,
							stdout:
								'{"certPresented":true,"certVerified":true}\n<<<update-probe>>>200 0.02',
							stderr: "",
						};
					if (url.endsWith("/generate_204"))
						return {
							exitCode: 0,
							stdout: "\n<<<update-probe>>>204 0.01",
							stderr: "",
						};
					if (url.endsWith(".json.sig"))
						return {
							exitCode: 0,
							stdout: "\n<<<update-probe>>>200 0.03",
							stderr: "",
						};
					return {
						exitCode: 0,
						stdout: "signed data\n<<<update-probe>>>200 0.04",
						stderr: "",
					};
				},
				mmIfnames: () => [],
				routerIfnames: () => [],
				dongleIfnames: () => [],
			},
		);
	const apt = await selection("apt");
	expect(apt.status).toBe("selected");
	if (apt.status === "selected") expect(apt.selected.family).toBe(4);
	expect(
		calls.some((argv) => argv.at(-1) === "http://apt.ceralive.tv/generate_204"),
	).toBe(true);
	expect(
		calls.some((argv) => argv.includes("--cert") && argv.includes("--key")),
	).toBe(true);
	expect(
		calls.some(
			(argv) => argv.includes("--interface") && argv.includes("if!eth0"),
		),
	).toBe(true);
	expect(
		calls.some(
			(argv) => argv.includes("--keyring") && argv.includes("/tmp/debian.gpg"),
		),
	).toBe(true);
	expect(
		calls.some((argv) =>
			argv.some((value) => value.includes("deb.debian.org/generate_204")),
		),
	).toBe(false);
	calls.length = 0;
	expect((await selection("os")).status).toBe("selected");
	expect(
		calls.some(
			(argv) =>
				argv.at(-1) ===
				"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig",
		),
	).toBe(true);
	expect(calls.some((argv) => argv.at(-1)?.includes("apt.ceralive.tv"))).toBe(
		false,
	);
});

async function probeOsSignature(input: {
	readonly httpCode?: number;
	readonly httpBody?: string;
	readonly httpsCode?: number;
	readonly httpsExit?: number;
}) {
	const calls: string[][] = [];
	const selection = await selectUpdateTransport(
		{ profile: "os", board: "rock-5b-plus", channel: "stable" },
		{
			listIfnames: () => ["eth0", "wwan0"],
			readSources: async () => "",
			credentials: async () => undefined,
			mmIfnames: () => ["wwan0"],
			routerIfnames: () => [],
			dongleIfnames: () => [],
			run: async (argv) => {
				calls.push(argv);
				if (argv[0] === "nmcli")
					return {
						exitCode: 0,
						stdout:
							"GENERAL.DEVICE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)\n\nGENERAL.DEVICE:wwan0\nGENERAL.TYPE:gsm\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:yes",
						stderr: "",
					};
				if (argv[0] === "resolvectl")
					return argv.includes("-6")
						? { exitCode: 1, stdout: "", stderr: "no IPv6 route" }
						: {
								exitCode: 0,
								stdout: `${argv.at(-1)}: 192.0.2.1`,
								stderr: "",
							};
				const url = argv.at(-1) ?? "";
				if (url.endsWith("/generate_204"))
					return {
						exitCode: 0,
						stdout: `${argv.includes("if!wwan0") ? "" : (input.httpBody ?? "")}\n<<<update-probe>>>${argv.includes("if!wwan0") ? 302 : (input.httpCode ?? 204)} 0.01`,
						stderr: "",
					};
				return argv.includes("if!wwan0")
					? { exitCode: 60, stdout: "", stderr: "TLS rejected" }
					: {
							exitCode: input.httpsExit ?? 0,
							stdout: `\n<<<update-probe>>>${input.httpsCode ?? 200} 0.02`,
							stderr: "",
						};
			},
		},
	);
	return { selection, calls };
}

test.each([404, 410])(
	"a verified images.ceralive.tv signature %i keeps the healthy eth0/IPv4 selectable",
	async (httpsCode) => {
		const { selection, calls } = await probeOsSignature({ httpsCode });
		expect(selection.status).toBe("selected");
		if (selection.status !== "selected") return;
		expect(selection.selected.candidate.ifname).toBe("eth0");
		expect(selection.selected.family).toBe(4);
		expect(selection.selected.hosts[0]?.state).toBe("clear");
		const signatureCall = calls.find(
			(argv) =>
				argv.at(-1) ===
					"https://images.ceralive.tv/channels/stable/rock-5b-plus.json.sig" &&
				argv.includes("if!eth0"),
		);
		expect(signatureCall).toContain("-I");
		expect(signatureCall).toContain("--resolve");
		expect(
			signatureCall?.some((arg) =>
				["-k", "--insecure", "-L", "--location"].includes(arg),
			),
		).toBe(false);
	},
);

test.each([302, 303, 307])(
	"a plain HTTP %i portal cannot be cleared by a verified HTTPS signature",
	async (httpCode) => {
		const { selection } = await probeOsSignature({ httpCode, httpsCode: 200 });
		expect(selection.status).toBe("none");
		expect(
			selection.ranked.find(
				(row) => row.candidate.ifname === "eth0" && row.family === 4,
			)?.hosts[0]?.state,
		).toBe("captive-http");
	},
);

test("a 200-with-body on the HTTP connectivity probe remains captive", async () => {
	const { selection } = await probeOsSignature({ httpBody: "portal" });
	expect(selection.status).toBe("none");
	expect(
		selection.ranked.find(
			(row) => row.candidate.ifname === "eth0" && row.family === 4,
		)?.hosts[0]?.state,
	).toBe("captive-http");
});

test("a TLS certificate failure leaves the OS uplink unhealthy", async () => {
	const { selection } = await probeOsSignature({ httpsExit: 60 });
	expect(selection.status).toBe("none");
	expect(
		selection.ranked.find(
			(row) => row.candidate.ifname === "eth0" && row.family === 4,
		)?.hosts[0]?.state,
	).toBe("tls-error");
});

test("a verified HTTPS 503 remains unhealthy", async () => {
	const { selection } = await probeOsSignature({ httpsCode: 503 });
	expect(selection.status).toBe("none");
	expect(
		selection.ranked.find(
			(row) => row.candidate.ifname === "eth0" && row.family === 4,
		)?.hosts[0]?.state,
	).not.toBe("clear");
});
