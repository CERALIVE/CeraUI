import assert from "node:assert/strict";

type ReadinessCommand = (
	argv: string[],
	env: Record<string, string | undefined>,
	signal: AbortSignal,
) => Promise<string>;

type ReadinessReceipt = {
	readonly device: string;
	readonly lastDeviceStates: string;
	readonly deviceStates: string;
	readonly rfkill: string;
	readonly hwsim: string;
	readonly generalStatus: string;
};

export class WifiDeviceReadinessTimeout extends Error {
	constructor(readonly receipt: ReadinessReceipt) {
		super(`UPGRADE-WIFI-READINESS: ${JSON.stringify(receipt)}`);
		this.name = "WifiDeviceReadinessTimeout";
	}
}

const managedStates = new Set([
	"disconnected",
	"connecting",
	"connected",
	"disconnecting",
	"failed",
]);

/** Each read observes NM state; the deadline never supplies readiness or retries an activation. */
export async function waitForManagedWifiDevice(
	device: string,
	nmcli: string,
	command: ReadinessCommand,
	redact: (text: string) => string,
	signal = AbortSignal.timeout(30_000),
): Promise<string> {
	const env = { ...process.env, LC_ALL: "C" };
	const inventory = [
		nmcli,
		"--colors",
		"no",
		"-t",
		"-f",
		"DEVICE,TYPE,STATE",
		"device",
		"status",
	];
	let lastDeviceStates = "";
	while (!signal.aborted) {
		try {
			lastDeviceStates = await command(inventory, env, signal);
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
			lastDeviceStates = `unreadable: ${redact(error.message)}`;
			continue;
		}
		if (signal.aborted) break;
		const ready = lastDeviceStates
			.split("\n")
			.map((line) => line.split(":"))
			.find(
				([name, type, state]) =>
					name === device &&
					type === "wifi" &&
					managedStates.has(state?.split(" ")[0] ?? ""),
			)?.[2];
		if (ready) return ready;
	}

	const capture = async (argv: string[]): Promise<string> => {
		try {
			return redact(await command(argv, env, AbortSignal.timeout(2000)));
		} catch (error: unknown) {
			if (!(error instanceof Error)) throw error;
			return redact(`unreadable: ${error.message}`);
		}
	};
	const [deviceStates, rfkill, hwsim, generalStatus] = await Promise.all([
		capture(inventory),
		capture(["rfkill", "list"]),
		capture(["iw", "dev"]),
		capture([nmcli, "--colors", "no", "general", "status"]),
	]);
	throw new WifiDeviceReadinessTimeout({
		device,
		lastDeviceStates: redact(lastDeviceStates),
		deviceStates,
		rfkill,
		hwsim,
		generalStatus,
	});
}

export async function selftestWifiReadiness(
	command: ReadinessCommand,
): Promise<void> {
	const reply = (
		text: string,
		env: Record<string, string | undefined>,
		signal: AbortSignal,
	) =>
		command(
			[process.execPath, "-e", "process.stdout.write(process.argv[1] ?? '')", text],
			env,
			signal,
		);
	for (const states of [
		["wlan1:wifi:disconnected"],
		[
			new Error("Temporary inventory failure\nwlan1:wifi:disconnected"),
			"wlan9:wifi:connected\nwlan1:ethernet:disconnected",
			"wlan9:wifi:connected\nwlan1:wifi:unmanaged",
			"wlan9:wifi:connected\nwlan1:wifi:unavailable",
			"wlan1:wifi:disconnected",
		],
	]) {
		let reads = 0;
		const ready = await waitForManagedWifiDevice(
			"wlan1",
			"nmcli",
			async (argv, env, signal) => {
				assert(argv.includes("DEVICE,TYPE,STATE"));
				const state = states[reads++];
				assert(state, "Readiness did not accept the ready observation");
				if (state instanceof Error)
					return command(
						[
							process.execPath,
							"-e",
							"process.stdout.write(process.argv[1]); process.exit(7)",
							state.message,
						],
						env,
						signal,
					);
				return reply(state, env, signal);
			},
			(text) => text,
		);
		assert.equal(ready, "disconnected");
		assert.equal(reads, states.length);
	}

	const secret = "readiness-diagnostic-secret";
	const deadline = AbortSignal.timeout(100);
	let observedUnavailable = false;
	const failed = await waitForManagedWifiDevice(
		"wlan1",
		"nmcli",
		async (argv, env, signal) => {
			if (signal === deadline && observedUnavailable) {
				// Hold a fake CLI read open; only the command's abort signal may end it.
				return command(
					[
						process.execPath,
						"-e",
						"Bun.serve({hostname:'127.0.0.1',port:0,fetch:()=>new Response()})",
					],
					env,
					signal,
				);
			}
			if (argv.includes("DEVICE,TYPE,STATE")) {
				observedUnavailable = true;
				return reply("wlan1:wifi:unavailable", env, signal);
			}
			if (argv[0] === "rfkill")
				return reply("wlan1: soft blocked yes", env, signal);
			if (argv[0] === "iw")
				return reply(`phy#0\nInterface wlan1\nSSID ${secret}`, env, signal);
			if (argv.includes("general"))
				return reply("disconnected:limited", env, signal);
			throw new Error("Unexpected readiness diagnostic command");
		},
		(text) => text.replaceAll(secret, "[REDACTED]"),
		deadline,
	).then(
		() => undefined,
		(error: unknown) => error,
	);
	assert(failed instanceof WifiDeviceReadinessTimeout);
	assert.equal(deadline.aborted, true);
	assert.deepEqual(
		{
			device: failed.receipt.device,
			deviceStates: failed.receipt.deviceStates,
			rfkill: failed.receipt.rfkill,
			hwsim: failed.receipt.hwsim,
			generalStatus: failed.receipt.generalStatus,
		},
		{
			device: "wlan1",
			deviceStates: "wlan1:wifi:unavailable",
			rfkill: "wlan1: soft blocked yes",
			hwsim: "phy#0\nInterface wlan1\nSSID [REDACTED]",
			generalStatus: "disconnected:limited",
		},
	);
	assert(!JSON.stringify(failed).includes(secret));
	assert(!failed.message.includes(secret));
	process.stdout.write(
		"hybrid-upgrade: Wi-Fi readiness selfcheck passed (immediate, state changes, bounded diagnostic failure; no VM)\n",
	);
}
