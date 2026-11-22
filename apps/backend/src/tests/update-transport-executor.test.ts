import { expect, mock, spyOn, test } from "bun:test";
import { updateCapabilityFileSchema } from "@ceraui/rpc/schemas";
import { logger } from "../helpers/logger.ts";
import { selectUpdateTransport } from "../modules/system/update-transport/executor.ts";
import { createUpdatePinController } from "../modules/system/update-transport/pin.ts";
import { assertNmDeviceShowFields } from "./helpers/nm-device-show-fixture.ts";

// Replay the all-device `device show` output options from nmcli(1), not a
// specific argv: options precede the command and selectors determine the rows.
function inventoryQuery(argv: readonly string[]) {
	if (argv.at(-2) !== "device" || argv.at(-1) !== "show") return;
	const options = argv.slice(1, -2);
	let style: "normal" | "terse" | "pretty" = "normal";
	let mode: "multiline" | "tabular" = "multiline";
	let escapeValues = true;
	let fields: string | undefined;
	for (let i = 0; i < options.length; i++) {
		const [option, inlineValue] = options[i]?.split("=", 2) ?? [];
		switch (option) {
			case "-t":
			case "--terse":
			case "-p":
			case "--pretty":
				// A repeated or conflicting print style is an nmcli input error.
				if (style !== "normal" || inlineValue !== undefined) return;
				style = option === "-t" || option === "--terse" ? "terse" : "pretty";
				break;
			case "-f":
			case "--fields":
				fields = inlineValue ?? options[++i];
				if (fields === undefined) return;
				break;
			case "-m":
			case "--mode": {
				const value = inlineValue ?? options[++i];
				if (value !== "multiline" && value !== "tabular") return;
				mode = value;
				break;
			}
			case "-e":
			case "--escape": {
				const value = inlineValue ?? options[++i];
				if (value !== "yes" && value !== "no") return;
				escapeValues = value === "yes";
				break;
			}
			default:
				return;
		}
	}
	return { style, mode, escapeValues, fields };
}

function inventoryReply(
	argv: readonly string[],
	...records: readonly string[]
) {
	const query = inventoryQuery(argv);
	if (!query)
		return { exitCode: 2, stdout: "", stderr: "Invalid inventory invocation" };
	const selector = query.fields?.toUpperCase() ?? "COMMON";
	if (selector === "") return { exitCode: 0, stdout: "", stderr: "" };
	// Without -f, nmcli prints common fields, including HWADDR. Replay just
	// the GENERAL fields needed to distinguish that wider, incompatible reply.
	const fields =
		selector === "COMMON" || selector === "ALL" || selector === "GENERAL"
			? "GENERAL.DEVICE,GENERAL.TYPE,GENERAL.HWADDR,GENERAL.STATE"
			: selector;
	try {
		assertNmDeviceShowFields(fields);
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === 2))
			throw error;
		return { exitCode: error.code, stdout: "", stderr: error.message };
	}
	const requested = fields.split(",");
	return {
		exitCode: 0,
		stdout: records
			.map((record) => {
				const values = new Map(
					record.split("\n").map((line) => {
						const separator = line.indexOf(":");
						return [line.slice(0, separator), line.slice(separator + 1)];
					}),
				);
				// An allowed field still appears even if the fixture has no value.
				const valueFor = (field: string) =>
					values.get(field) ??
					(field === "GENERAL.HWADDR" ? "02:00:00:00:00:00" : "--");
				if (query.mode === "tabular") {
					return requested
						.map((field) => {
							const value = valueFor(field);
							return query.escapeValues
								? value.replace(/[:\\]/g, "\\$&")
								: value;
						})
						.join("\n");
				}
				return requested
					.map((field) => {
						const label = `${field}:`;
						return `${query.style === "terse" ? label : label.padEnd(40)}${valueFor(field)}`;
					})
					.join("\n");
			})
			.join("\n\n"),
		stderr: "",
	};
}

test("an OS selection logs every failed cellular interface and family once", async () => {
	const logged: unknown[][] = [];
	const warn = spyOn(logger, "warn").mockImplementation(
		(...args: unknown[]) => {
			logged.push(args);
			return logger;
		},
	);
	try {
		await selectUpdateTransport(
			{ profile: "os", board: "rock-5b-plus", channel: "stable" },
			{
				listIfnames: () => ["wwan0", "wwan1"],
				readSources: async () => "",
				credentials: async () => undefined,
				mmIfnames: () => ["wwan0", "wwan1"],
				routerIfnames: () => [],
				dongleIfnames: () => [],
				run: async (argv) => {
					if (argv[0] === "nmcli")
						return inventoryReply(
							argv,
							...["wwan0", "wwan1"].map(
								(ifname, index) =>
									`GENERAL.DEVICE:cdc-wdm${index}\nGENERAL.IP-IFACE:${ifname}\nGENERAL.TYPE:gsm\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:yes`,
							),
						);
					return { exitCode: 1, stdout: "", stderr: "" };
				},
			},
		);
		expect(
			logged.filter(([message]) => message === "No healthy update transport"),
		).toEqual([
			[
				"No healthy update transport",
				{
					profile: "os",
					findings: [
						{
							ifname: "wwan0",
							family: 4,
							reason: "metered cellular IPv4: images.ceralive.tv dns-failed",
						},
						{
							ifname: "wwan0",
							family: 6,
							reason: "metered cellular IPv6: images.ceralive.tv dns-failed",
						},
						{
							ifname: "wwan1",
							family: 4,
							reason: "metered cellular IPv4: images.ceralive.tv dns-failed",
						},
						{
							ifname: "wwan1",
							family: 6,
							reason: "metered cellular IPv6: images.ceralive.tv dns-failed",
						},
					],
				},
			],
		]);
	} finally {
		warn.mockRestore();
	}
});

test.each(["eth0", "wwan0"])(
	"APT and OS profiles probe only their configured hosts, on both families, bound to %s",
	async (ifname) => {
		const calls: string[][] = [];
		const selection = async (profile: "apt" | "os") =>
			selectUpdateTransport(
				{ profile, board: "rock-5b-plus", channel: "stable" },
				{
					listIfnames: () => [ifname],
					readSources: async () =>
						"Types: deb\nURIs: https://deb.debian.org/debian\nSuites: trixie\nSigned-By: /tmp/debian.gpg",
					credentials: async () => ({
						cert: "/tmp/client.crt",
						key: "/tmp/client.key",
					}),
					run: async (argv) => {
						calls.push(argv);
						if (argv[0] === "nmcli")
							return inventoryReply(
								argv,
								`GENERAL.DEVICE:${ifname === "wwan0" ? "cdc-wdm0" : ifname}\nGENERAL.IP-IFACE:${ifname}\nGENERAL.TYPE:${ifname === "wwan0" ? "gsm" : "ethernet"}\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)`,
							);
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
		const inventory = calls.find(([command]) => command === "nmcli") ?? [];
		expect(
			inventoryQuery(inventory)?.fields?.toUpperCase().split(","),
		).toContain("GENERAL.IP-IFACE");
		if (apt.status === "selected") {
			expect(apt.selected.family).toBe(4);
			expect(apt.selected.candidate).toEqual({
				ifname,
				kind: ifname === "wwan0" ? "cellular" : "ethernet",
				metered: ifname === "wwan0",
			});
		}
		expect(
			calls.some(
				(argv) => argv.at(-1) === "http://apt.ceralive.tv/generate_204",
			),
		).toBe(true);
		expect(
			calls.some((argv) => argv.includes("--cert") && argv.includes("--key")),
		).toBe(true);
		expect(
			calls.some(
				(argv) => argv.includes("--interface") && argv.includes(`if!${ifname}`),
			),
		).toBe(true);
		expect(
			calls.some(
				(argv) =>
					argv.includes("--keyring") && argv.includes("/tmp/debian.gpg"),
			),
		).toBe(true);
		expect(
			calls.some((argv) =>
				argv.some((value) => value.includes("deb.debian.org/generate_204")),
			),
		).toBe(false);
		calls.length = 0;
		const os = await selection("os");
		expect(os.status).toBe("selected");
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
		expect(
			calls
				.filter((argv) => argv[0] === "curl")
				.every(
					(argv) => argv[argv.indexOf("--interface") + 1] === `if!${ifname}`,
				),
		).toBe(true);
		if (ifname === "wwan0") {
			const pin = createUpdatePinController({
				readCapabilities: async () =>
					updateCapabilityFileSchema.parse({
						schema: 1,
						features: ["transport-uidrange"],
						apt_uid: 42042,
						ota_uid: 42043,
					}),
				run: async () => "",
			});
			await pin.sweep();
			const approveMetered = mock(() => false);
			const start = mock(async () => "started");
			await expect(
				pin.run("os", os, start, { approveMetered }),
			).rejects.toMatchObject({ reason: "no-transport" });
			expect(approveMetered).toHaveBeenCalledWith(
				expect.objectContaining({
					candidate: { ifname: "wwan0", kind: "cellular", metered: true },
				}),
			);
			expect(start).not.toHaveBeenCalled();
		}
	},
);

async function probeOsSignature(input: {
	readonly httpCode?: number;
	readonly httpBody?: string;
	readonly httpsCode?: number;
	readonly httpsExit?: number;
	readonly inventoryFailure?: "empty output" | "non-zero exit";
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
				if (argv[0] === "nmcli") {
					const reply = inventoryReply(
						argv,
						"GENERAL.DEVICE:eth0\nGENERAL.IP-IFACE:eth0\nGENERAL.TYPE:ethernet\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:no (guessed)",
						"GENERAL.DEVICE:cdc-wdm0\nGENERAL.IP-IFACE:wwan0\nGENERAL.TYPE:gsm\nGENERAL.STATE:100 (connected)\nGENERAL.METERED:yes",
					);
					if (input.inventoryFailure === "empty output")
						return { ...reply, stdout: "" };
					if (input.inventoryFailure === "non-zero exit")
						return { ...reply, exitCode: 1 };
					return reply;
				}
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

test.each(["empty output", "non-zero exit"] as const)(
	"no transport is probed after nmcli returns %s",
	async (inventoryFailure) => {
		const { selection, calls } = await probeOsSignature({ inventoryFailure });
		expect(selection).toMatchObject({ status: "none", ranked: [] });
		expect(calls.map(([command]) => command)).toEqual(["nmcli"]);
	},
);

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
