import { createDbusTransport } from "@ceralive/modem-control/transport";
import { run } from "../../helpers/run.ts";
import {
	nmConnGetFields,
	nmConnsGet,
	nmcliParseSep,
} from "./network-manager.ts";
import {
	type NmProfileReadTrace,
	nmProfileObservation,
} from "./network-manager-profile-diagnostics.ts";
import {
	observeNmProfileFile,
	readNmProfileFileSecret,
} from "./network-manager-profile-file.ts";

export type NmProfileInstance = {
	readonly [nmProfileObservation]?: NmProfileReadTrace;
	readonly path: string;
	readonly fingerprint: string;
	readonly runId?: string | undefined;
	readonly file?:
		| {
				readonly filename: string;
				readonly device: string;
				readonly inode: string;
				readonly ctime: string;
		  }
		| undefined;
};

export function sameNmProfileFile(
	expected: NmProfileInstance["file"],
	observed: NmProfileInstance["file"],
): boolean {
	return Boolean(
		expected &&
			observed &&
			expected.filename === observed.filename &&
			expected.device === observed.device &&
			expected.inode === observed.inode &&
			expected.ctime === observed.ctime,
	);
}

export const nmActivationBus = {
	open: () =>
		createDbusTransport({
			busAddress:
				process.env.DBUS_SYSTEM_BUS_ADDRESS?.trim() ||
				"unix:path=/var/run/dbus/system_bus_socket",
			reconnect: { enabled: false },
		}),
};

/** A unique NM connection name, scoped by the bus UUID so reboot cannot reuse it. */
export async function nmRunId(): Promise<string | undefined> {
	const target = [
		"--system",
		"call",
		"org.freedesktop.DBus",
		"/org/freedesktop/DBus",
		"org.freedesktop.DBus",
	];
	try {
		const bus = await run("busctl", [...target, "GetId"], {
			timeout: 1000,
			maxBuffer: 4096,
		});
		const owner = await run(
			"busctl",
			[...target, "GetNameOwner", "s", "org.freedesktop.NetworkManager"],
			{ timeout: 1000, maxBuffer: 4096 },
		);
		const busId = /^s "([0-9a-f]{32})"\s*$/.exec(bus)?.[1];
		const uniqueOwner = /^s "(:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+)"\s*$/.exec(
			owner,
		)?.[1];
		return busId && uniqueOwner ? `${busId}/${uniqueOwner}` : undefined;
	} catch (error: unknown) {
		if (error instanceof Error) return undefined;
		throw error;
	}
}

// Cosmetic profile names, activation timestamps and policy writes are not resource identity.
const INSTANCE_FIELDS = [
	"connection.interface-name",
	"match.path",
	"802-11-wireless.mode",
	"802-11-wireless.ssid",
	"802-11-wireless.mac-address",
	"802-11-wireless.band",
	"802-11-wireless.channel",
	"802-11-wireless-security.key-mgmt",
	"802-11-wireless-security.psk",
	"802-11-wireless-security.proto",
	"802-11-wireless-security.pairwise",
	"802-11-wireless-security.group",
	"802-11-wireless-security.pmf",
	"ipv4.method",
	"ipv6.method",
] as const;

function comparableField(field: string, value: string): string {
	if (field.endsWith("mac-address")) return value.toLowerCase();
	if (field.endsWith("-flags")) return value.split(" ")[0] ?? value;
	if (field === "802-11-wireless-security.pmf") {
		switch (value.split(" ")[0]) {
			case "0":
				return "default";
			case "1":
				return "disable";
			case "2":
				return "optional";
			case "3":
				return "required";
		}
	}
	return value;
}

async function profilePath(uuid: string): Promise<string | null | undefined> {
	const rows = await nmConnsGet("uuid,dbus-path");
	if (!rows) return undefined;
	let path: string | null = null;
	for (const row of rows) {
		if (!row) continue;
		const [id, value] = nmcliParseSep(row);
		if (
			!id ||
			!value?.match(/^\/org\/freedesktop\/NetworkManager\/Settings\/\d+$/)
		)
			return undefined;
		if (id === uuid) path = value;
	}
	return path;
}

/** Null proves absence; undefined means NM could not establish an instance. */
export async function readNmProfileInstance(
	uuid: string,
	submitted?: Readonly<Record<string, string>>,
	trace: NmProfileReadTrace = {},
): Promise<NmProfileInstance | null | undefined> {
	const path = await profilePath(uuid);
	trace.path = path;
	if (path === null || path === undefined) {
		trace.exit = path === null ? "profile-absent" : "path-unreadable";
		return path;
	}
	const runId = await nmRunId();
	if (!runId) {
		trace.exit = "run-unreadable";
		return undefined;
	}
	const file = await observeNmProfileFile(uuid, trace, "firstStat");
	const requested = [
		...INSTANCE_FIELDS,
		...Object.keys(submitted ?? {}).filter(
			(field) => !INSTANCE_FIELDS.some((known) => known === field),
		),
	];
	const visible = requested.filter(
		(field) => field !== "802-11-wireless-security.psk",
	);
	const observedFields = [...new Set([...visible, "connection.timestamp"])];
	const values = await nmConnGetFields(uuid, observedFields);
	const activationTimestamp =
		values?.[observedFields.indexOf("connection.timestamp")];
	if (activationTimestamp !== undefined)
		trace.activationTimestamp = activationTimestamp;
	trace.afterPath = await profilePath(uuid);
	trace.pathChanged = trace.afterPath !== path;
	const afterFile = await observeNmProfileFile(uuid, trace, "secondStat");
	trace.runChanged = (await nmRunId()) !== runId;
	trace.fileReceiptPresent = sameNmProfileFile(file, afterFile);
	if (file && afterFile && !trace.fileReceiptPresent)
		trace.fileReason = "changed-between-reads";
	if (!values || values.length < visible.length) {
		trace.exit = "fields-unreadable";
		return undefined;
	}
	const secret = trace.fileReceiptPresent
		? await readNmProfileFileSecret(file, trace)
		: undefined;
	if (trace.fileReceiptPresent && !secret) {
		trace.exit = "persistent-secret-unreadable";
		return undefined;
	}
	const fields = requested.map((field) =>
		field === "802-11-wireless-security.psk"
			? (secret?.password ?? "")
			: (values[visible.indexOf(field)] ?? ""),
	);
	trace.fieldDigests = Object.fromEntries(
		requested.map((name, index) => [
			name,
			new Bun.CryptoHasher("sha256").update(fields[index] ?? "").digest("hex"),
		]),
	);
	const mismatches: string[] = [];
	for (const [field, expected] of Object.entries(submitted ?? {})) {
		const actual = fields[requested.indexOf(field)];
		if (
			actual === undefined ||
			comparableField(field, actual) !== comparableField(field, expected)
		)
			mismatches.push(field);
	}
	trace.submittedChanges = mismatches;
	if (submitted && Object.keys(submitted).length)
		trace.submittedFieldCount = Object.keys(submitted).length;
	if (mismatches.length || trace.pathChanged || trace.runChanged) {
		trace.exit = mismatches.length
			? "submitted-settings-mismatch"
			: trace.pathChanged
				? "path-changed-during-read"
				: "run-changed-during-read";
		return undefined;
	}
	const instance: NmProfileInstance = {
		path,
		runId,
		file: sameNmProfileFile(file, afterFile) ? file : undefined,
		fingerprint: new Bun.CryptoHasher("sha256")
			.update(JSON.stringify(fields.slice(0, INSTANCE_FIELDS.length)))
			.digest("hex"),
	};
	Object.defineProperty(instance, nmProfileObservation, { value: trace });
	return instance;
}

/** NM-run-local object continuity; passive authority also requires file equality. */
export function sameNmProfileInstance(
	expected: NmProfileInstance | null | undefined,
	observed: NmProfileInstance | null | undefined,
): boolean {
	return Boolean(
		expected &&
			observed?.file &&
			expected.runId === observed.runId &&
			expected.path === observed.path &&
			expected.fingerprint === observed.fingerprint,
	);
}

export function sameNmProfileActivation(
	expected: NmProfileInstance | null | undefined,
	observed: NmProfileInstance | null | undefined,
): boolean {
	return (
		sameNmProfileInstance(expected, observed) &&
		sameNmProfileFile(expected?.file, observed?.file)
	);
}

/** Passive continuity always requires unchanged file evidence, within or across runs. */
export function sameNmProfileResource(
	expected: NmProfileInstance | null | undefined,
	observed: NmProfileInstance | null | undefined,
): boolean {
	return Boolean(
		expected &&
			observed?.file &&
			expected.fingerprint === observed.fingerprint &&
			sameNmProfileFile(expected.file, observed.file) &&
			(expected.runId === observed.runId
				? expected.path === observed.path
				: expected.runId && observed.runId),
	);
}
