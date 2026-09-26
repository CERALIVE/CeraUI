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
