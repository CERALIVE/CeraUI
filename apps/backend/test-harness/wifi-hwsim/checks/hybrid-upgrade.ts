import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import {
	selftestWifiReadiness,
	waitForManagedWifiDevice,
} from "./hybrid-readiness.ts";

const password = process.env.HWSIM_UPGRADE_PASSWORD ?? crypto.randomUUID();
const stateSchema = z.object({
	parent: z.string(),
	mac: z.string(),
	virtual: z.string(),
	ap: z.string().uuid(),
	uplink: z.string().uuid(),
	ssid: z.string(),
});

function redacted(text: string): string {
	return text
		.replaceAll(password, "[REDACTED]")
		.replaceAll("ceratest1234", "[REDACTED]");
}

function causeText(error: unknown): string {
	if (!(error instanceof Error)) return redacted(String(error));
	const stderr =
		"stderr" in error && typeof error.stderr === "string" ? error.stderr : "";
	return redacted(
		`${error.name}: ${error.message}${stderr ? `\n${stderr}` : ""}${
			error.cause === undefined ? "" : `\nCaused by: ${causeText(error.cause)}`
		}`,
	);
}

/** Spawned pid -> first argv tokens (redacted), so audit pids of short-lived processes stay attributable. */
const spawnedCalls: string[] = [];

async function command(
	argv: string[],
	env: Record<string, string | undefined> = process.env,
	signal?: AbortSignal,
): Promise<string> {
	const child = Bun.spawn(argv, {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
		timeout: 180_000,
		...(signal ? { signal, killSignal: "SIGKILL" } : {}),
	});
	spawnedCalls.push(`${child.pid} ${redacted(argv.slice(0, 3).join(" "))}`);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	assert.equal(
		code,
		0,
		redacted(`${argv[0]} exited ${code}\n${stdout}\n${stderr}`),
	);
	return stdout.trim();
}

async function simulatedRadios(): Promise<string[]> {
	assert.equal(process.getuid?.(), 0, "Run as root in the hwsim VM");
	assert.equal(process.env.HWSIM_REPO, "/repo", "Use the isolated VM runner");
	assert.equal(
		await realpath(process.cwd()),
		"/repo",
		"Start in the exported repository",
	);
	const radios: string[] = [];
	for (const name of (await readdir("/sys/class/net")).sort()) {
		const phy = await realpath(`/sys/class/net/${name}/phy80211`).catch(
			() => "",
		);
		if (phy.includes("/mac80211_hwsim/") && !name.startsWith("clap-"))
			radios.push(name);
	}
	assert.equal(radios.length, 4, "The upgrade gate requires four hwsim radios");
	return radios;
}

type MountEntry = {
	point: string;
	options: string;
	fstype: string;
	superOptions: string;
};

/** The /proc/self/mountinfo entry covering path; the last of equal mount points shadows the rest. */
function mountEntry(path: string, mountinfo: string): MountEntry | undefined {
	let best: MountEntry | undefined;
	for (const line of mountinfo.split("\n")) {
		const [left, right] = line.split(" - ");
		if (!left || !right) continue;
		const fields = left.split(" ");
		const point = (fields[4] ?? "").replace(/\\(\d{3})/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
		const [fstype = "", , superOptions = ""] = right.split(" ");
		const covers =
			point === "/" || path === point || path.startsWith(`${point}/`);
		if (covers && point.length >= (best?.point.length ?? 0))
			best = { point, options: fields[5] ?? "", fstype, superOptions };
	}
	return best;
}

/** Log the shim's mount and permissions, then prove the backend's PATH lookup can execute it. */
async function shimPreflight(
	shim: string,
	env: Record<string, string | undefined>,
): Promise<void> {
	const info = await stat(shim);
	const mount = mountEntry(
		await realpath(shim),
		await readFile("/proc/self/mountinfo", "utf8"),
	);
	const mode = (info.mode & 0o7777).toString(8).padStart(4, "0");
	process.stdout.write(
		`UPGRADE-SHIM-RECEIPT: dir=${dirname(shim)} mount=${mount?.point ?? "unknown"} options=${mount?.options ?? "unknown"} fstype=${mount?.fstype ?? "unknown"} super=${mount?.superOptions ?? "unknown"} mode=${mode} uid=${info.uid} gid=${info.gid}\n`,
	);
	const fail = (reason: string): never => {
		throw new Error(`UPGRADE-SHIM-PREFLIGHT: ${reason}`);
	};
	await access(shim, constants.X_OK).catch((error: unknown) =>
		fail(`shim is not executable: ${causeText(error)}`),
	);
	if (Bun.which("nmcli", { PATH: env.PATH ?? "" }) !== shim)
		fail("PATH does not resolve nmcli to the shim");
	await command([shim, "--version"], env).catch((error: unknown) =>
		fail(`shim did not run: ${causeText(error)}`),
	);
	process.stdout.write("UPGRADE-SHIM-PREFLIGHT: PASS\n");
}

/** Success phases assert a published row; the failed-intent control asserts that none is published. */
function publishesRow(phase: string): boolean {
	return phase !== "failed-intent";
}

/**
 * Per profile, the names of compared fields that differ (`keyfile-bytes` for the persisted file), then each
 * audited write on an unrelated profile. Values, secrets included, are never printed.
 */
function profileFieldDiff(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
	writes: readonly AuditRecord[] = [],
): string[] {
	const fields = (settings: string | undefined) =>
		new Map(
			(settings ?? "")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const at = line.indexOf(":");
					return [line.slice(0, at), line.slice(at + 1)] as const;
				}),
		);
	const lines: string[] = [];
	for (const uuid of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const old = fields(before.get(uuid));
		const now = fields(after.get(uuid));
		const label = `${uuid} (${old.get("connection.id") ?? now.get("connection.id") ?? "?"})`;
		if (!before.has(uuid) || !after.has(uuid)) {
			lines.push(`${label}: profile ${before.has(uuid) ? "removed" : "added"}`);
			continue;
		}
		const changed = [...new Set([...old.keys(), ...now.keys()])]
			.filter((name) => old.get(name) !== now.get(name))
			.sort();
		if (changed.length) lines.push(`${label}: ${changed.join(", ")}`);
	}
	for (const write of writes) {
		const id =
			fields(before.get(write.uuid)).get("connection.id") ??
			fields(after.get(write.uuid)).get("connection.id") ??
			"?";
		lines.push(`${write.uuid} (${id}): audit ${write.op} by pid=${write.pid}`);
	}
	return lines;
}

type AuditRecord = {
	at: number;
	op: string;
	uuid: string;
	pid: string;
	result: string;
};

const journalEntry = z.object({
	MESSAGE: z.unknown(),
	__REALTIME_TIMESTAMP: z.string(),
});

/** NetworkManager audit records from `journalctl -o json`, reduced to time (ms), op, uuid, pid and result. */
function journalAudit(json: string): AuditRecord[] {
	return json
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.flatMap((line) => {
			const entry = journalEntry.parse(JSON.parse(line));
			const message = typeof entry.MESSAGE === "string" ? entry.MESSAGE : "";
			if (!message.includes("audit: ")) return [];
			const field = (name: string) =>
				message.match(new RegExp(`\\b${name}="?([^"\\s]*)"?`))?.[1] ?? "?";
			return [
				{
					at: Number(entry.__REALTIME_TIMESTAMP) / 1000,
					op: field("op"),
					uuid: field("uuid"),
					pid: field("pid"),
					result: field("result"),
				},
			];
		});
}

async function nmAudit(since: number): Promise<AuditRecord[]> {
	return journalAudit(
		await command([
			"journalctl",
			"-u",
			"NetworkManager",
			"--since",
			`@${since}`,
			"--no-pager",
			"-o",
			"json",
			"--output-fields=MESSAGE",
		]),
	);
}

/** Writes NM audited on an unrelated UUID since `from` (ms): update, delete, an add over it, or a secrets clear. */
function unrelatedProfileWrites(
	records: readonly AuditRecord[],
	unrelated: ReadonlySet<string>,
	from: number,
): AuditRecord[] {
	return records.filter(
		(record) =>
			record.at >= from &&
			unrelated.has(record.uuid) &&
			(record.op.startsWith("connection-update") ||
				[
					"connection-add",
					"connection-add-activate",
					"connection-delete",
					"connection-clear-secrets",
				].includes(record.op)),
	);
}

/**
 * A profile's comparable state: every non-secret nmcli field, plus the SHA-256 of its persisted keyfile
 * bytes. Secret fields read `<hidden>` or have a `-flags` sibling; their nmcli value follows secret
 * visibility after activation, so the keyfile bytes are their authority.
 */
function profileSerialization(
	terse: string,
	keyfile: Uint8Array | undefined,
): string {
	// Activation timestamps and GENERAL describe runtime, not saved settings.
	const lines = terse
		.split("\n")
		.filter(
			(line) =>
				/^[a-z0-9-]+\./.test(line) && !line.startsWith("connection.timestamp:"),
		);
	const names = new Set(lines.map((line) => line.slice(0, line.indexOf(":"))));
	const kept = lines.filter((line) => {
		const name = line.slice(0, line.indexOf(":"));
		return (
			line.slice(name.length + 1) !== "<hidden>" &&
			!names.has(`${name}-flags`) &&
			!names.has(`${name.replace(/\d+$/, "")}-flags`)
		);
	});
	const bytes = keyfile
		? new Bun.CryptoHasher("sha256").update(keyfile).digest("hex")
		: "none";
	return [...kept, `keyfile-bytes:${bytes}`].join("\n");
}

/** Print NM audit records since the scenario started and map their pids to processes and recorded calls. */
async function captureNmAudit(since: number, ledgerPath: string): Promise<void> {
	const records = await nmAudit(since);
	for (const record of records)
		process.stdout.write(
			redacted(
				`UPGRADE-NM-AUDIT: ${new Date(record.at).toISOString()} op=${record.op} uuid=${record.uuid} pid=${record.pid} result=${record.result}\n`,
			),
		);
	const processes = new Map(
		(await command(["ps", "-eo", "pid=,ppid=,comm="]))
			.split("\n")
			.map((line) => line.trim().split(/\s+/))
			.filter((fields) => fields.length >= 3)
			.map(([pid = "", ppid, ...comm]) => [pid, `${comm.join(" ")} ppid=${ppid}`]),
	);
	const ledger = new Map(
		[
			...spawnedCalls,
			...(await readFile(ledgerPath, "utf8").catch(() => "")).split("\n"),
		]
			.filter(Boolean)
			.map((line) => {
				const at = line.indexOf(" ");
				return [line.slice(0, at), line.slice(at + 1)] as const;
			}),
	);
	for (const pid of new Set(records.map((record) => record.pid)))
		process.stdout.write(
			redacted(
				`UPGRADE-NM-AUDIT-PID: pid=${pid} process=${processes.get(pid) ?? "exited"} call=${ledger.get(pid) ?? "unrecorded"}\n`,
			),
		);
}

type FailedIntentObservation = {
	published: boolean;
	advertised: boolean;
	apActive: boolean;
	uplinkKept: boolean;
	kernelAp: boolean;
	configUnchanged: boolean;
	degraded: string[];
	failures: string[];
};

/**
 * Designed fail-closed outcome of a failed durable intent write. Policy returns before disabling
 * autoconnect (wifi-hotspot-profile-policy.ts:172-185); the reconciler reports it and arms a retry
 * (wifi-adapter-reconciler.ts:76-80, wifi-adapter-reconcile-retry.ts:62-68); discovery returns before
 * publishing any row (wifi-interfaces.ts:752-754). The live AP, uplink and saved config stay untouched.
 */
function assertFailedIntentOutcome(
	mac: string,
	observed: FailedIntentObservation,
): void {
	const expected: FailedIntentObservation = {
		published: false,
		advertised: false,
		apActive: true,
		uplinkKept: true,
		kernelAp: true,
		configUnchanged: true,
		degraded: [`wifi-hotspot-autoconnect:${mac}`],
		failures: ["intent persistence"],
	};
	for (const key of Object.keys(expected) as (keyof FailedIntentObservation)[])
		assert.deepEqual(
			observed[key],
			expected[key],
			`failed-intent: ${key} is ${JSON.stringify(observed[key])}, the designed recovery outcome is ${JSON.stringify(expected[key])}`,
		);
}

/** Distinct reasons the reconciler logged for mac; the intent-persistence error name is dropped. */
function failedIntentReasons(lines: string[], mac: string): string[] {
	const marker = `Wi-Fi hotspot autoconnect failed for ${mac}`;
	const reasons = lines.flatMap((line) => {
		const at = line.indexOf(marker);
		const colon = at === -1 ? -1 : line.indexOf(": ", at + marker.length);
		if (colon === -1) return [];
		const reason =
			(line.slice(colon + 2).split('"')[0] ?? "")
				.split("\u001b")[0]
				?.trim() ?? "";
		return [
			reason.startsWith("intent persistence") ? "intent persistence" : reason,
		];
	});
	return [...new Set(reasons)];
}

// Observe the durable file at the real CLI boundary, then forward to real NM.
async function nmcliBoundary(): Promise<void> {
	await simulatedRadios();
	const args = process.argv.slice(3);
	const uuid = process.env.HWSIM_UPGRADE_AP;
	const auto = args.indexOf("connection.autoconnect");
	if (
		process.env.HWSIM_UPGRADE_GUARD === "1" &&
		args[0] === "con" &&
		args[1] === "modify" &&
		args[2] === uuid &&
		auto !== -1 &&
		args[auto + 1] === "no"
	) {
		const root = process.env.HWSIM_UPGRADE_STATE;
		const mac = process.env.HWSIM_UPGRADE_MAC;
		assert(root && mac, "Missing intent observation state");
		const config = z
			.object({ wifi_modes: z.record(z.string(), z.string()).optional() })
			.parse(JSON.parse(await readFile(join(root, "config.json"), "utf8")));
		assert.equal(
			config.wifi_modes?.[mac],
			"hybrid",
			"UPGRADE-INTENT-FIRST: autoconnect disabled before durable hybrid intent",
		);
		await appendFile(join(root, "intent-first"), "hybrid\n");
	}
	const nmcli = process.env.HWSIM_UPGRADE_NMCLI;
	assert(nmcli, "Missing real nmcli path");
	const child = Bun.spawn([nmcli, ...args], {
		env: process.env,
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
		timeout: 35_000,
	});
	// Attribute this call in NM audit records; the product reads only nmcli's own stdout.
	const ledger = process.env.HWSIM_UPGRADE_STATE;
	if (ledger)
		await appendFile(
			join(ledger, "nmcli-calls"),
			`${child.pid} ${redacted(args.slice(0, 3).join(" "))}\n`,
		);
	process.exitCode = await child.exited;
}

async function candidate(phase: string): Promise<void> {
	const radios = await simulatedRadios();
	const root = process.env.HWSIM_UPGRADE_STATE;
	assert(root, "Missing candidate state directory");
	const state = stateSchema.parse(
		JSON.parse(await readFile(join(root, "state.json"), "utf8")),
	);
	const config = await import("../../../src/modules/config.ts");
	const credentials = await import(
		"../../../src/modules/wifi/hotspot-credentials.ts"
	);
	const devices = await import("../../../src/modules/wifi/wifi-device-list.ts");
	const interfaces = await import(
		"../../../src/modules/wifi/wifi-interfaces.ts"
	);
	const { getWifiInterfaceByMacAddress } = await import(
		"../../../src/modules/wifi/wifi-connections.ts"
	);
	const { observedWifiAdapterMode } = await import(
		"../../../src/modules/wifi/wifi-adapter-mode.ts"
	);
	const { reconcileWifiAdapterModes } = await import(
		"../../../src/modules/wifi/wifi-adapter-mode-restore.ts"
	);
	const { refreshWifiCapabilities } = await import(
		"../../../src/modules/wifi/wifi-capabilities.ts"
	);
	const { wifiBuildMsg } = await import("../../../src/modules/wifi/wifi.ts");
	const { wifiHotspotStop } = await import(
		"../../../src/modules/wifi/wifi-hotspot-config.ts"
	);
	const { nmConnGetFields, nmDeviceProp } = await import(
		"../../../src/modules/network/network-manager.ts"
	);
	const { shouldUseMocks } = await import("../../../src/mocks/mock-service.ts");
	const radio = await import("./first-ap-radio.ts");
	const { clearRecentLogLines, getRecentLogLines } = await import(
		"../../../src/helpers/logger.ts"
	);
	const { getBootReadiness } = await import(
		"../../../src/modules/system/readiness.ts"
	);
	assert.equal(
		shouldUseMocks(),
		false,
		"Candidate must use real NetworkManager",
	);
	config.setConfigFilePath(join(root, "config.json"));
	await config.loadConfig();
	await credentials.initHotspotCredentials(
		join(root, "hotspot_credentials.json"),
	);
	const savedConfig = await readFile(join(root, "config.json"), "utf8");
	if (phase === "failed-intent") {
		config.setConfigFilePath(join(root, "write-is-a-directory"));
		clearRecentLogLines();
	}

	if (publishesRow(phase)) {
		// Same mechanism as the saved-profile check: hwsim has no vendor/product, so discovery keeps a natively seeded row.
		await radio.seedObservedRadioRow({
			ifname: state.parent,
			owner: state.mac,
			uuid: state.ap,
			ssid: state.ssid,
			password,
		});
		await radio.observeSavedProfileRadio(state.parent);
	} else {
		devices.wifiDeviceListStartUpdate();
		for (const name of radios) {
			devices.wifiDeviceListAdd(
				name,
				(await readFile(`/sys/class/net/${name}/address`, "utf8")).trim(),
			);
		}
		devices.wifiDeviceListEndUpdate();
		await interfaces.wifiUpdateDevices();
	}
	if (phase === "failed-intent") {
		assert.equal(
			config.getConfig().wifi_modes?.[state.mac],
			undefined,
			"Failed intent write must not publish hybrid intent in memory",
		);
		assert.equal(
			(
				await nmConnGetFields(state.ap, ["connection.autoconnect"] as const)
			)?.[0],
			"yes",
			"Failed intent write must preserve the autoconnect recovery path",
		);
		assertFailedIntentOutcome(state.mac, {
			published: getWifiInterfaceByMacAddress(state.mac) !== undefined,
			advertised: Object.values(wifiBuildMsg()).some(
				(entry) => entry.hotspot?.name === state.ssid,
			),
			apActive:
				(await nmDeviceProp(state.virtual, "GENERAL.CON-UUID"))?.[0] ===
				state.ap,
			uplinkKept:
				(await nmDeviceProp(state.parent, "GENERAL.CON-UUID"))?.[0] ===
				state.uplink,
			kernelAp: /\btype AP\b/.test(
				await command(["iw", "dev", state.virtual, "info"]),
			),
			configUnchanged:
				(await readFile(join(root, "config.json"), "utf8")) === savedConfig,
			degraded: getBootReadiness().degradedSubsystems.filter((subsystem) =>
				subsystem.startsWith("wifi-hotspot-"),
			),
			failures: failedIntentReasons(getRecentLogLines(), state.mac),
		});
		// The success-case publication assertions below cannot apply: discovery correctly published nothing.
		interfaces.terminateWifiDiscovery();
		process.stdout.write(
			`hybrid-upgrade: ${phase} passed (fail-closed; nothing published or mutated)\n`,
		);
		return;
	} else {
		assert.equal(
			config.getConfig().wifi_modes?.[state.mac],
			"hybrid",
			"Missing restored hybrid intent",
		);
		await refreshWifiCapabilities(radios);
		await reconcileWifiAdapterModes();
		await interfaces.wifiUpdateDevices();
		assert.equal(
			(
				await nmConnGetFields(state.ap, ["connection.autoconnect"] as const)
			)?.[0],
			"no",
			"Hybrid profile must remain autoconnect off",
		);
	}
	const row = getWifiInterfaceByMacAddress(state.mac);
	assert(row, `${phase}: candidate did not discover the owned radio`);
	assert.equal(
		observedWifiAdapterMode(row),
		"hybrid",
		`${phase}: active hybrid AP disappeared`,
	);
	assert.equal(
		row.concurrentHotspot?.activeConn,
		state.ap,
		`${phase}: candidate lost the live AP UUID`,
	);
	const wire = wifiBuildMsg()[row.id];
	assert(wire?.hotspot, `${phase}: AP missing from operator status`);
	assert.equal(
		wire.hotspot.name,
		state.ssid,
		`${phase}: operator status lost the SSID`,
	);
	assert(
		wire.hotspot.password === password,
		`${phase}: operator status changed the synthetic credential`,
	);
	assert.equal(
		(await nmDeviceProp(state.parent, "GENERAL.CON-UUID"))?.[0],
		state.uplink,
		`${phase}: hybrid operation dropped the station uplink`,
	);
	assert.match(
		await command(["iw", "dev", state.virtual, "info"]),
		/\btype AP\b/,
		`${phase}: the kernel no longer reports the AP`,
	);
	if (phase === "stop") {
		const result = await wifiHotspotStop({ device: row.id });
		assert(
			result.success,
			`UPGRADE-AP-RETAINED: Stop failed: ${JSON.stringify(result)}`,
		);
		await interfaces.wifiUpdateDevices();
		assert.equal(
			wifiBuildMsg()[row.id]?.hotspot,
			undefined,
			"Stopped AP remains visible as active",
		);
		assert.equal(
			(await nmDeviceProp(state.parent, "GENERAL.CON-UUID"))?.[0],
			state.uplink,
			"Stop dropped the station uplink",
		);
		assert(
			!(
				await command(["nmcli", "-g", "UUID", "connection", "show", "--active"])
			)
				.split("\n")
				.includes(state.ap),
			"Stop left the AP active in NetworkManager",
		);
		assert.equal(
			config.getConfig().wifi_modes?.[state.mac],
			"station",
			"Stop did not remember station intent",
		);
	}
	interfaces.terminateWifiDiscovery();
	process.stdout.write(`hybrid-upgrade: ${phase} passed\n`);
}

async function main(): Promise<void> {
	const radios = await simulatedRadios();
	assert(
		Bun.which("dnsmasq"),
		"Install dnsmasq-base in the guest for shared IPv4",
	);
	const [, parent, other] = radios;
	assert(parent && other, "Missing hybrid and control radios");
	const mac = (
		await readFile(`/sys/class/net/${parent}/phy80211/macaddress`, "utf8")
	)
		.trim()
		.toLowerCase();
	const otherMac = (
		await readFile(`/sys/class/net/${other}/phy80211/macaddress`, "utf8")
	)
		.trim()
		.toLowerCase();
	assert.notEqual(
		mac,
		otherMac,
		"Unrelated owned station requires a distinct radio",
	);
	const state = {
		parent,
		mac,
		virtual: `clap-${parent}`.slice(0, 15),
		ap: crypto.randomUUID(),
		uplink: crypto.randomUUID(),
		ssid: `CeraUpgrade-${crypto.randomUUID().slice(0, 8)}`,
	};
	// The shim must execute: /run refused exec on Debian 13, and the exported tree is exec-capable and disposable.
	const root = await mkdtemp("/repo/.hwsim-upgrade-");
	const created: string[] = [];
	const nmcli = Bun.which("nmcli");
	assert(nmcli, "NetworkManager CLI is missing");
	const activate = async (uuid: string, device: string) => {
		const state = await waitForManagedWifiDevice(
			device,
			nmcli,
			command,
			redacted,
		);
		process.stdout.write(`UPGRADE-WIFI-READY: device=${device} state=${state}\n`);
		await command([nmcli, "-w", "30", "connection", "up", uuid]);
	};
	const env = {
		...process.env,
		NODE_ENV: "production",
		MOCK_MODE: "false",
		HWSIM_UPGRADE_PASSWORD: password,
		HWSIM_UPGRADE_STATE: root,
		HWSIM_UPGRADE_AP: state.ap,
		HWSIM_UPGRADE_MAC: mac,
		HWSIM_UPGRADE_NMCLI: nmcli,
		PATH: `${root}:${process.env.PATH}`,
	};
	const runCandidate = async (phase: string, guard = false) => {
		const output = await command(
			[process.execPath, import.meta.path, "--candidate", phase],
			{ ...env, HWSIM_UPGRADE_GUARD: guard ? "1" : "0" },
		);
		process.stdout.write(`${redacted(output)}\n`);
	};
	const add = async (
		uuid: string,
		device: string,
		ssid: string,
		fields: string[],
	) => {
		await command([
			nmcli,
			"connection",
			"add",
			"type",
			"wifi",
			"ifname",
			device,
			"connection.id",
			ssid,
			"connection.uuid",
			uuid,
			"802-11-wireless.ssid",
			ssid,
			...fields,
		]);
		created.push(uuid);
	};
	let lastSettings = new Map<string, string>();
	const snapshot = async () => {
		const settingsByUuid = new Map<string, string>();
		const files = new Map(
			(await command([nmcli, "-g", "UUID,FILENAME", "connection", "show"]))
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const at = line.indexOf(":");
					return [
						line.slice(0, at),
						line.slice(at + 1).replace(/\\(.)/g, "$1"),
					] as const;
				}),
		);
		const uuids = [...files.keys()]
			.filter((uuid) => uuid && uuid !== state.ap)
			.sort();
		const hashes = await Promise.all(
			uuids.map(async (uuid) => {
				const filename = files.get(uuid);
				const settings = profileSerialization(
					await command([
						nmcli,
						"--terse",
						"--fields",
						"all",
						"connection",
						"show",
						uuid,
					]),
					filename ? await Bun.file(filename).bytes() : undefined,
				);
				assert(
					settings.includes("connection.uuid:"),
					"Unrelated profile snapshot is empty",
				);
				settingsByUuid.set(uuid, settings);
				return [
					uuid,
					new Bun.CryptoHasher("sha256").update(settings).digest("hex"),
				];
			}),
		);
		lastSettings = settingsByUuid;
		return hashes;
	};
	let beforeSettings = lastSettings;
	const explainProfileChange = async (
		writes: readonly AuditRecord[],
		check: () => Promise<void>,
	) => {
		try {
			await check();
		} catch (error) {
			for (const line of profileFieldDiff(beforeSettings, lastSettings, writes))
				process.stdout.write(`UPGRADE-UNRELATED-PROFILES-DIFF: ${line}\n`);
			throw error;
		}
	};
	const scenarioStart = Math.floor(Date.now() / 1000) - 1;
	try {
		await writeFile(join(root, "state.json"), JSON.stringify(state), {
			mode: 0o600,
		});
		await writeFile(join(root, "config.json"), "{}\n", { mode: 0o600 });
		await mkdir(join(root, "write-is-a-directory"));
		await writeFile(
			join(root, "nmcli"),
			`#!/bin/sh\nexec '${process.execPath}' '${import.meta.path}' --nmcli "$@"\n`,
			{ mode: 0o700 },
		);
		await shimPreflight(join(root, "nmcli"), env);
		for (const device of [parent, other]) {
			await command([nmcli, "device", "set", device, "managed", "yes"]);
			await command([nmcli, "device", "set", device, "autoconnect", "no"]);
		}
		await add(state.uplink, parent, "CeraUpgrade-uplink", [
			"connection.autoconnect",
			"yes",
			"802-11-wireless.ssid",
			"CeraTest",
			"802-11-wireless.mac-address",
			mac,
			"802-11-wireless-security.key-mgmt",
			"wpa-psk",
			"802-11-wireless-security.psk",
			"ceratest1234",
			"ipv4.method",
			"manual",
			"ipv4.addresses",
			"192.0.2.10/24",
			"ipv6.method",
			"disabled",
		]);
		await activate(state.uplink, parent);
		await command([
			"iw",
			"dev",
			parent,
			"interface",
			"add",
			state.virtual,
			"type",
			"managed",
		]);
		await command(["udevadm", "settle", "--timeout=20"]);
		await command([nmcli, "device", "set", state.virtual, "managed", "yes"]);
		// Released hybrid binding: clap ifname, no physical pin, autoconnect on.
		await add(state.ap, state.virtual, state.ssid, [
			"connection.autoconnect",
			"yes",
			"connection.autoconnect-priority",
			"999",
			"802-11-wireless.mode",
			"ap",
			"802-11-wireless.band",
			"bg",
			"802-11-wireless.channel",
			"6",
			"802-11-wireless-security.key-mgmt",
			"wpa-psk",
			"802-11-wireless-security.psk",
			password,
			"802-11-wireless-security.pairwise",
			"ccmp",
			"802-11-wireless-security.group",
			"ccmp",
			"802-11-wireless-security.proto",
			"rsn",
			"802-11-wireless-security.pmf",
			"disable",
			"ipv4.method",
			"shared",
			"ipv6.method",
			"ignore",
		]);
		await activate(state.ap, state.virtual);
		const station = crypto.randomUUID();
		await add(station, other, "CeraUpgrade-owned-station", [
			"connection.autoconnect",
			"yes",
			"802-11-wireless.mac-address",
			otherMac,
			"802-11-wireless.mode",
			"infrastructure",
		]);
		await add(crypto.randomUUID(), "clap-foreign", "CeraUpgrade-unowned-AP", [
			"connection.autoconnect",
			"yes",
			"802-11-wireless.mode",
			"ap",
			"connection.autoconnect-priority",
			"999",
		]);
		await writeFile(
			join(root, "hotspot_credentials.json"),
			JSON.stringify({
				version: 2,
				adapters: {
					[mac]: {
						ssid: state.ssid,
						password,
						conn: state.ap,
						channel: "ch_6",
					},
					[otherMac]: {
						ssid: "CeraUpgrade-owned-station",
						password,
						conn: station,
					},
				},
			}),
			{ mode: 0o600 },
		);
		const before = await snapshot();
		beforeSettings = lastSettings;
		// Audit window: everything after the baseline, so the harness's own adds and activations are excluded.
		const auditFrom = Date.now();
		await runCandidate("failed-intent");
		assert.equal(
			await Bun.file(join(root, "intent-first")).exists(),
			false,
			"Failed-intent control must not produce a successful write receipt",
		);
		await runCandidate("startup", true);
		assert.equal(
			await readFile(join(root, "intent-first"), "utf8"),
			"hybrid\n",
			"UPGRADE-INTENT-FIRST: missing real CLI boundary observation",
		);
		process.stdout.write(
			"UPGRADE-INTENT-FIRST: PASS (including failed-write recovery control)\n",
		);
		await runCandidate("service-restart");
		const restartWrites = unrelatedProfileWrites(
			await nmAudit(scenarioStart),
			new Set(beforeSettings.keys()),
			auditFrom,
		);
		await explainProfileChange(restartWrites, async () =>
			assert.deepEqual(
				await snapshot(),
				before,
				"UPGRADE-UNRELATED-PROFILES: startup/restart changed a profile",
			),
		);
		await explainProfileChange(restartWrites, async () =>
			assert.deepEqual(
				restartWrites.map(
					(write) => `${write.op} ${write.uuid} pid=${write.pid}`,
				),
				[],
				"UPGRADE-UNRELATED-AUDIT: startup/restart wrote an unrelated profile",
			),
		);

		// The SSH-owned runner cannot survive a guest OS reboot. Simulate loss of
		// NM and the virtual netdev, retaining only disk and the physical radios.
		await command([nmcli, "connection", "down", state.ap]);
		await command(["iw", "dev", state.virtual, "del"]);
		await command(["systemctl", "restart", "NetworkManager"]);
		await activate(state.uplink, parent);
		assert(
			!(await command([nmcli, "-g", "UUID", "connection", "show", "--active"]))
				.split("\n")
				.includes(state.ap),
			"Reboot control: AP autonomously activated before CeraUI",
		);
		await runCandidate("reboot");
		process.stdout.write(
			"UPGRADE-REBOOT: PASS (cold NM/netdev state and fresh candidate process; no OS reboot)\n",
		);
		await runCandidate("stop");
		process.stdout.write(
			"UPGRADE-AP-RETAINED: PASS (startup/restart retained visible AP; operator Stop succeeded)\n",
		);
		await explainProfileChange([], async () =>
			assert.deepEqual(
				await snapshot(),
				before,
				"UPGRADE-UNRELATED-PROFILES: restore/Stop changed a profile",
			),
		);
		process.stdout.write(
			"UPGRADE-UNRELATED-PROFILES: PASS (all saved fields except activation timestamp)\n",
		);
	} finally {
		// Evidence before cleanup deletes profiles or the call ledger.
		await captureNmAudit(scenarioStart, join(root, "nmcli-calls")).catch(
			(error: unknown) =>
				process.stdout.write(
					`UPGRADE-NM-AUDIT: capture failed: ${causeText(error)}\n`,
				),
		);
		for (const uuid of created.reverse()) {
			await command([nmcli, "connection", "delete", uuid]);
		}
		if (await Bun.file(`/sys/class/net/${state.virtual}/ifindex`).exists())
			await command(["iw", "dev", state.virtual, "del"]);
		await rm(root, { recursive: true, force: true });
	}
	process.stdout.write(
		"hybrid-upgrade: PASS (simulated radios only; no released-Rock qualification)\n",
	);
}

try {
	if (process.argv[2] === "--selftest") {
		const cause = Object.assign(new Error(`nmcli PSK ${password}`), {
			stderr: `synthetic uplink PSK ceratest1234; AP PSK ${password}`,
		});
		const text = causeText(new Error("activation failed", { cause }));
		assert.equal(
			text,
			"Error: activation failed\nCaused by: Error: nmcli PSK [REDACTED]\nsynthetic uplink PSK [REDACTED]; AP PSK [REDACTED]",
			"Failure causes must remain useful without exposing synthetic credentials",
		);
		const mountinfo =
			"22 1 0:21 / / rw,relatime - ext4 /dev/vda1 rw\n30 22 0:25 / /run rw,nosuid,nodev,noexec - tmpfs tmpfs rw,mode=755\n31 22 0:26 / /mnt/a\\040b rw - tmpfs tmpfs rw\n";
		assert.deepEqual(
			[
				mountEntry("/repo/.hwsim-upgrade-x/nmcli", mountinfo)?.options,
				mountEntry("/run/hwsim-upgrade-x/nmcli", mountinfo)?.options,
				mountEntry("/mnt/a b/nmcli", mountinfo)?.point,
				mountEntry("/runner/nmcli", mountinfo)?.point,
			],
			["rw,relatime", "rw,nosuid,nodev,noexec", "/mnt/a b", "/"],
			"Mount receipts must name the mount that covers the shim",
		);
		const owner = "02:00:00:00:01:00";
		const designed: FailedIntentObservation = {
			published: false,
			advertised: false,
			apActive: true,
			uplinkKept: true,
			kernelAp: true,
			configUnchanged: true,
			degraded: [`wifi-hotspot-autoconnect:${owner}`],
			failures: failedIntentReasons(
				[
					`{"level":"error","msg":"Wi-Fi hotspot autoconnect failed for ${owner}: intent persistence Error"}`,
					`{"level":"error","msg":"Wi-Fi hotspot autoconnect failed for ${owner}: intent persistence Error"}`,
					'{"level":"error","msg":"Wi-Fi hotspot autoconnect failed for 02:00:00:00:02:00: could not disable x"}',
				],
				owner,
			),
		};
		assertFailedIntentOutcome(owner, designed);
		assert.throws(
			() => assertFailedIntentOutcome(owner, { ...designed, published: true }),
			/failed-intent: published is true/,
			"A published row after a failed intent write must fail the control",
		);
		assert.throws(
			() => assertFailedIntentOutcome(owner, { ...designed, failures: [] }),
			/failed-intent: failures is \[\]/,
			"A missing reconciler failure report must fail the control",
		);
		process.stdout.write(
			"hybrid-upgrade: redacted failure selfcheck passed (no VM)\n",
		);
		assert.deepEqual(
			["failed-intent", "startup", "service-restart", "reboot", "stop"].map(
				publishesRow,
			),
			[false, true, true, true, true],
			"Every success phase must seed its row; the failed-intent control must not",
		);
		process.stdout.write(
			"hybrid-upgrade: failed-intent outcome selfcheck passed (no VM)\n",
		);
		const uplink = (psk: string) =>
			`connection.id:CeraUpgrade-uplink\nconnection.uuid:u1\n802-11-wireless-security.key-mgmt:wpa-psk\n802-11-wireless-security.psk:${psk}\n802-11-wireless-security.psk-flags:0 (none)\nconnection.timestamp:1`;
		const keyfile = new TextEncoder().encode("[wifi-security]\npsk=ceratest1234\n");
		const baseline = profileSerialization(uplink(""), keyfile);
		for (const psk of ["<hidden>", "ceratest1234"])
			assert.equal(
				profileSerialization(uplink(psk), keyfile),
				baseline,
				"Secret visibility alone must not change the comparison",
			);
		const edited = profileSerialization(
			uplink(""),
			new TextEncoder().encode("[wifi-security]\npsk=changed\n"),
		);
		assert.notEqual(edited, baseline, "A keyfile change must fail the comparison");
		const retyped = profileSerialization(
			uplink("").replace("wpa-psk", "sae"),
			keyfile,
		);
		const diff = profileFieldDiff(
			new Map([["u1", baseline]]),
			new Map([["u1", edited]]),
		);
		assert.deepEqual(
			[
				diff,
				profileFieldDiff(new Map([["u1", baseline]]), new Map([["u1", retyped]])),
			],
			[
				["u1 (CeraUpgrade-uplink): keyfile-bytes"],
				["u1 (CeraUpgrade-uplink): 802-11-wireless-security.key-mgmt"],
			],
			"The diff must name exactly the keyfile-bytes or non-secret field that changed",
		);
		assert(
			![...diff, baseline, edited].join("\n").includes("ceratest1234"),
			"Comparisons and diffs must never carry a secret value",
		);
		const entry = (message: string, microseconds: string) =>
			JSON.stringify({ MESSAGE: message, __REALTIME_TIMESTAMP: microseconds });
		const records = journalAudit(
			[
				entry(
					'<info>  [1.2] audit: op="connection-update" uuid="u1" name="CeraUpgrade-uplink" args="802-11-wireless-security.psk" pid=1234 uid=0 result="success"',
					"2000000",
				),
				entry('<info>  [1.3] audit: op="connection-activate" uuid="u1" pid=7 uid=0 result="success"', "2000000"),
				entry('<info>  [1.4] audit: op="connection-update" uuid="owned" pid=5 uid=0 result="success"', "2000000"),
				entry('<info>  [0.1] audit: op="connection-add" uuid="u1" pid=9 uid=0 result="success"', "1000"),
				entry("<info>  [1.5] device (wlan1): state change", "2000000"),
			].join("\n"),
		);
		assert.deepEqual(
			Object.keys(records[0] ?? {}).sort(),
			["at", "op", "pid", "result", "uuid"],
			"Audit records keep time, op, uuid, pid and result only",
		);
		const writes = unrelatedProfileWrites(records, new Set(["u1"]), 1000);
		assert.deepEqual(
			[
				writes.map((write) => `${write.op} ${write.uuid} pid=${write.pid}`),
				profileFieldDiff(new Map([["u1", baseline]]), new Map([["u1", baseline]]), writes),
			],
			[
				["connection-update u1 pid=1234"],
				["u1 (CeraUpgrade-uplink): audit connection-update by pid=1234"],
			],
			"An audited update on an unrelated UUID must fail the guard and be named",
		);
		assert.deepEqual(
			unrelatedProfileWrites(records, new Set(["u1"]), 3000),
			[],
			"Records before the audit window must not count",
		);
		process.stdout.write(
			"hybrid-upgrade: profile field-diff and audit selfcheck passed (no VM)\n",
		);
		await selftestWifiReadiness(command);
	} else if (process.argv[2] === "--nmcli") await nmcliBoundary();
	else if (process.argv[2] === "--candidate") {
		const phase = process.argv[3];
		assert(phase, "Missing candidate lifecycle phase");
		await candidate(phase);
		// Imported backend pollers belong to this disposable candidate process.
		process.exit(0);
	} else await main();
} catch (error) {
	console.error(`hybrid-upgrade: FAIL\n${causeText(error)}`);
	if (process.argv[2] === "--candidate") process.exit(1);
	process.exitCode = 1;
}
