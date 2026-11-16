import { spyOn } from "bun:test";
import { readFileSync } from "node:fs";
import * as exec from "../../helpers/exec.ts";
import { logger } from "../../helpers/logger.ts";
import * as runner from "../../helpers/run.ts";
import {
	clearHotspotProfileCreation,
	recordHotspotProfileCreation,
	rememberHotspotCredentials,
} from "../../modules/wifi/hotspot-credentials.ts";
import {
	defaultHotspotDeps,
	startHotspotForInterface,
} from "../../modules/wifi/wifi-hotspot-activation.ts";
import { settlePending } from "../../modules/wifi/wifi-hotspot-monitor.ts";
import { runHotspotProfileOperation } from "../../modules/wifi/wifi-hotspot-profile-operation.ts";
import type { HotspotActivationDeps } from "../../modules/wifi/wifi-hotspot-types.ts";
import { firstApInstances } from "./wifi-first-ap-instances.ts";
import { decodeProfile, encodeProfile } from "./wifi-first-ap-keyfile-codec.ts";
import { wifiFrameFixture } from "./wifi-frame-fixture.ts";
import {
	mockQualifiedHybridDriver,
	qualifiedHybridEvidence,
} from "./wifi-hybrid-qualification.ts";

export const MAC = "dc:a6:32:aa:bb:c0";
export const OTHER_UUID = "11111111-1111-4111-8111-111111111111";

export async function firstAp(
	failure?:
		| "ownership"
		| "uuid"
		| "up"
		| "add"
		| "receipt"
		| "ownership-up"
		| "ownership-autoconnect"
		| "autoconnect"
		| "post-up-throw"
		| "add-after-create",
	hybrid = false,
) {
	const state = await wifiFrameFixture(false);
	if (hybrid) mockQualifiedHybridDriver();
	const secret = `synthetic-${crypto.randomUUID()}`;
	delete state.row.hotspot.conn;
	state.row.hotspot.name = "First AP";
	state.row.hotspot.password = secret;
	const commands: string[][] = [];
	const logs: string[] = [];
	const profiles = new Set([OTHER_UUID]);
	const autoconnect = new Set<string>();
	const settings = new Map<string, Record<string, string>>();
	const instances = firstApInstances(profiles, settings);
	const faults = {
		upTimeout: false,
		autoconnectTimeout: false,
		deleteFails: false,
		deleteTimeout: false,
		downFails: false,
		downTimeout: false,
		offFails: false,
		receiptUnreadable: false,
		observedMode: "ap",
		confirmationPending: false,
		beforeAdd: async (): Promise<void> => undefined,
		afterAdd: async (): Promise<void> => undefined,
		afterSecretWrite: async (): Promise<void> => undefined,
		afterDeviceRead: (): void => undefined,
		afterModify: (): void => undefined,
	};
	let created: string | undefined;
	let active: string | undefined;
	for (const level of ["debug", "info", "warn", "error"] as const)
		spyOn(logger, level).mockImplementation((message, ...metadata) => {
			logs.push(
				String(message),
				...metadata.map((value) => String(JSON.stringify(value))),
			);
			return logger;
		});
	spyOn(exec, "execFileP").mockImplementation(async (bin, argv = []) => {
		if (bin === "busctl")
			return { stdout: instances.busReply(argv), stderr: "" };
		if (bin !== "nmcli") throw new Error("Unexpected binary");
		const args = [...argv];
		commands.push(args);
		const add = args[0] === "connection" && args[1] === "add";
		if (add) {
			if (failure === "add")
				throw new Error(`Command failed with supplied credential ${secret}`);
			created = args[args.indexOf("connection.uuid") + 1];
			if (!created) throw new Error("Missing pre-generated UUID");
			await faults.beforeAdd();
			profiles.add(created);
			settings.set(
				created,
				Object.fromEntries(
					Array.from({ length: (args.length - 2) / 2 }, (_, i) => [
						args[i * 2 + 2] ?? "",
						args[i * 2 + 3] ?? "",
					]),
				),
			);
			instances.add(created);
			await faults.afterAdd();
			if (failure === "add-after-create")
				throw new Error(`Command timed out with supplied credential ${secret}`);
			if (failure === "ownership") state.row.hotspot = { ...state.row.hotspot };
			const receipt = failure === "uuid" ? OTHER_UUID : created;
			return {
				stdout:
					failure === "receipt" || faults.receiptUnreadable
						? `unexpected receipt ${secret}`
						: `Connection 'Hotspot' (${receipt}) successfully added.`,
				stderr: "",
			};
		}
		if (args[0] === "connection" && args[1] === "load") {
			const fields = decodeProfile(readFileSync(args[2] ?? "", "utf8"));
			const uuid = fields["connection.uuid"];
			if (!uuid || !profiles.has(uuid))
				throw new Error("Unknown fake keyfile UUID");
			settings.set(uuid, fields);
			instances.bumpVersion(uuid);
			await faults.afterSecretWrite();
			faults.afterModify();
			return { stdout: "", stderr: "" };
		}
		if (args[0] === "conn" && args[1] === "del") {
			if (faults.deleteFails) throw new Error("NM deletion unavailable");
			profiles.delete(args[2] ?? "");
			autoconnect.delete(args[2] ?? "");
			if (active === args[2]) active = undefined;
			if (faults.deleteTimeout)
				throw new Error("NM delete committed then timed out");
			return { stdout: "Connection successfully deleted", stderr: "" };
		}
		if (args[0] === "conn" && args[1] === "down") {
			if (faults.downFails) throw new Error("NM deactivation unavailable");
			if (active !== args[2]) throw new Error("Connection is not active");
			if (active === args[2]) active = undefined;
			if (faults.downTimeout)
				throw new Error("NM down committed then timed out");
			return { stdout: "Connection successfully deactivated", stderr: "" };
		}
		if (args[0] === "-w" && args[2] === "conn" && args[3] === "up") {
			if (!profiles.has(args[4] ?? "")) throw new Error("Unknown connection");
			if (failure === "up") throw new Error("NM refused activation");
			active = args[4];
			const activePath = instances.activate(active);
			if (faults.upTimeout) throw new Error("NM up committed then timed out");
			if (failure === "ownership-up")
				state.row.hotspot = { ...state.row.hotspot, conn: OTHER_UUID };
			return {
				stdout: `Connection successfully activated (D-Bus active path: ${activePath})`,
				stderr: "",
			};
		}
		if (args[0] === "con" && args[1] === "modify") {
			const uuid = args[2] ?? "";
			const off = args[args.indexOf("connection.autoconnect") + 1] === "no";
			if (off && faults.offFails)
				throw new Error("NM autoconnect suppression unavailable");
			if (
				failure === "autoconnect" &&
				args.includes("connection.autoconnect-priority")
			)
				throw new Error("NM refused autoconnect write");
			Object.assign(
				settings.get(uuid) ?? {},
				Object.fromEntries(
					Array.from({ length: (args.length - 3) / 2 }, (_, i) => [
						args[i * 2 + 3] ?? "",
						args[i * 2 + 4] ?? "",
					]),
				),
			);
			instances.files.write(uuid);
			instances.bumpVersion(uuid);
			if (args.includes("connection.autoconnect")) {
				if (off) autoconnect.delete(uuid);
				else autoconnect.add(uuid);
				if (
					failure === "ownership-autoconnect" &&
					args.includes("connection.autoconnect-priority")
				)
					state.row.hotspot = { ...state.row.hotspot, conn: OTHER_UUID };
				if (
					faults.autoconnectTimeout &&
					args.includes("connection.autoconnect-priority")
				)
					throw new Error("NM refused autoconnect write");
			}
			faults.afterModify();
			return { stdout: "", stderr: "" };
		}
		if (args.includes("--fields") || args.includes("--get-values")) {
			const stdout = instances.read(args, {
				active,
				pending: faults.confirmationPending,
				mode: faults.observedMode,
				ifname: hybrid ? "clap-wlan0" : "wlan0",
			});
			if (args.includes("device")) faults.afterDeviceRead();
			return { stdout, stderr: "" };
		}
		throw new Error("Unexpected nmcli operation");
	});
	spyOn(runner, "runWithStdin").mockImplementation(async (bin, args, input) => {
		if (
			bin !== "nmcli" ||
			args.slice(0, 3).join(" ") !== "--offline connection modify"
		)
			throw new Error("Unexpected stdin NM operation");
		commands.push([...args]);
		const fields = decodeProfile(input);
		for (let i = 3; i < args.length; i += 2) {
			const key = args[i];
			const value = args[i + 1];
			if (key === undefined || value === undefined)
				throw new Error("Invalid offline fields");
			fields[key] = value;
		}
		return encodeProfile(fields);
	});
	const deps: HotspotActivationDeps = {
		...defaultHotspotDeps,
		...(hybrid ? qualifiedHybridEvidence : {}),
		readCapabilities: () => ({ staApCombo: { supported: hybrid } }),
		preferConcurrentAp: () => hybrid,
		ensureConcurrentInterface: async () => ({
			ifname: "clap-wlan0",
			created: false,
		}),
		credentials: {
			get: () => ({ ssid: "First AP", password: secret }),
			remember: (owner, credentials) => {
				if (failure === "post-up-throw" && active)
					throw new Error("Post-up persistence failed");
				rememberHotspotCredentials(owner, credentials);
			},
			recordCreation: recordHotspotProfileCreation,
			clearCreation: clearHotspotProfileCreation,
		},
		findHotspotConn: async () => undefined,
		pruneHotspotConns: async () => undefined,
		wifiUpdateSavedConns: async () => {
			if (created) state.row.hotspot.conn = created;
		},
		broadcastState: () => undefined,
		setDupIpSuppression: () => undefined,
	};
	delete deps.recordIntent;
	delete deps.pollHotspotActive;
	return {
		...state,
		secret,
		commands,
		logs,
		profiles,
		settings,
		nm: instances,
		restoreProfilePaths: instances.restorePaths,
		replace: instances.replace,
		autoconnect,
		faults,
		deps,
		created: () => created,
		active: () => active,
		armRetainedProfile: async () => {
			if (!created) throw new Error("Missing retained profile to arm");
			const uuid = created;
			const result = await runHotspotProfileOperation({
				uuid,
				kind: "modify",
				fields: { "connection.autoconnect": "yes" },
				run: (fields) => deps.nmConnSetFields(uuid, fields),
			});
			if (!result.success) throw new Error("Retained fixture arm failed");
		},
		observe: (uuid: string | undefined, mode: string) => {
			active = uuid;
			faults.observedMode = mode;
			faults.confirmationPending = false;
		},
		start: () => startHotspotForInterface(MAC, state.row, deps),
		fields: () => {
			const args = commands.find(
				(argv) => argv[0] === "connection" && argv[1] === "add",
			);
			const safe = args?.map((arg, index) =>
				args[index - 1] === "802-11-wireless-security.psk" ? "<redacted>" : arg,
			);
			return {
				...Object.fromEntries(
					Array.from({ length: (safe?.length ?? 2) / 2 - 1 }, (_, index) => [
						safe?.[index * 2 + 2],
						safe?.[index * 2 + 3],
					]),
				),
				...(settings.get(created ?? "")?.["802-11-wireless-security.psk"]
					? { "802-11-wireless-security.psk": "<redacted>" }
					: {}),
			};
		},
		restore: async () => {
			await settlePending("wlan0", false);
			await state.restore();
			instances.files.close();
		},
	};
}
