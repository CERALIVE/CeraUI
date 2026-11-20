import { resolve } from "node:path";
import {
	nmConnsGet,
	nmcliParseSep,
} from "../../modules/network/network-manager.ts";
import { encodeProfile } from "./wifi-first-ap-keyfile-codec.ts";
import { firstApKeyfiles } from "./wifi-first-ap-keyfiles.ts";

export function firstApInstances(
	profiles: Set<string>,
	settings: Map<string, Record<string, string>>,
) {
	const paths = new Map<string, string>();
	const files = firstApKeyfiles((uuid) =>
		encodeProfile({
			"connection.uuid": uuid,
			"connection.type": "802-11-wireless",
			...settings.get(uuid),
		}),
	);
	let instance = 0;
	let activePath = "";
	let bus = 1;
	let owner = 1;
	let version = "1.42.4";
	const revisions = new Map<string, bigint>();
	const synchronized = new Map<string, string>();
	const activate = (uuid?: string) => {
		if (uuid) revisions.set(uuid, (revisions.get(uuid) ?? 0n) + 2n);
		activePath = `/org/freedesktop/NetworkManager/ActiveConnection/${++instance}`;
		return activePath;
	};
	const add = (uuid: string) => {
		paths.set(uuid, `/org/freedesktop/NetworkManager/Settings/${++instance}`);
		revisions.set(uuid, 1n);
		files.write(uuid);
	};
	return {
		add,
		activate,
		activePath: () => activePath,
		files,
		sync: () => {
			for (const [uuid, fields] of settings) {
				const bytes = JSON.stringify(fields);
				profiles.add(uuid);
				if (!paths.has(uuid)) add(uuid);
				else if (synchronized.get(uuid) !== bytes) files.write(uuid);
				synchronized.set(uuid, bytes);
			}
			for (const uuid of profiles)
				if (!settings.has(uuid)) profiles.delete(uuid);
		},
		run: () => ({ bus, owner }),
		version: (value: string) => {
			version = value;
		},
		bumpVersion: (uuid: string) =>
			revisions.set(uuid, (revisions.get(uuid) ?? 0n) + 1n),
		restoreRun: (run: { bus: number; owner: number }) => {
			bus = run.bus;
			owner = run.owner;
		},
		restart: (restartBus = false) => {
			if (restartBus) {
				bus++;
				owner = 1;
			} else owner++;
			instance = 100;
			for (const uuid of profiles)
				paths.set(
					uuid,
					`/org/freedesktop/NetworkManager/Settings/${++instance}`,
				);
			activate();
		},
		busReply: (args: readonly string[]) => {
			if (args.includes("get-property")) {
				if (args.at(-1) === "Version") return `s "${version}"\n`;
				const uuid = [...paths].find(([, path]) => args.includes(path))?.[0];
				if (
					args.at(-1) === "VersionId" &&
					!version.startsWith("1.42") &&
					uuid &&
					profiles.has(uuid)
				)
					return `t ${revisions.get(uuid) ?? 1n}\n`;
				throw new Error("Unknown NM property");
			}
			if (args.includes("GetId"))
				return `s "${bus.toString(16).padStart(32, "0")}"\n`;
			if (args.includes("GetNameOwner")) return `s ":1.${owner}"\n`;
			throw new Error("Unknown fixture bus call");
		},
		paths: () => [...paths],
		restorePaths: (snapshot: readonly string[][]) => {
			for (const [uuid, path] of snapshot) {
				if (!uuid || !path) throw new Error("Invalid fixture settings path");
				paths.set(uuid, path);
				instance = Math.max(instance, Number(path.split("/").at(-1)));
			}
		},
		replace: (uuid: string, name = "Operator AP", recreate = true) => {
			const fields = settings.get(uuid);
			if (fields) fields["802-11-wireless.ssid"] = name;
			if (recreate) add(uuid);
			else files.write(uuid);
			activate();
		},
		read: (
			args: string[],
			observation: {
				active: string | undefined;
				pending: boolean;
				mode: string;
				ifname: string;
			},
		) => {
			const named = args.includes("--fields") && args.includes("multiline");
			if (args.includes("--fields") && !named) {
				const fields = args[args.indexOf("--fields") + 1];
				if (fields === "device,type,state,con-uuid")
					return `${observation.ifname}:wifi:${observation.pending || !observation.active ? "disconnected" : "connected"}:${observation.active ?? ""}`;
				return [...profiles]
					.map((uuid) =>
						fields === "uuid,dbus-path"
							? `${uuid}:${paths.get(uuid) ?? "/org/freedesktop/NetworkManager/Settings/999"}`
							: fields === "uuid"
								? uuid
								: fields === "uuid,active"
									? `${uuid}:${observation.active === uuid ? "yes" : "no"}`
									: fields === "uuid,filename"
										? `${uuid}:${files.filename(uuid)}`
										: `${uuid}:802-11-wireless`,
					)
					.join("\n");
			}
			const requested = (
				args[args.indexOf(named ? "--fields" : "--get-values") + 1] ?? ""
			).split(",");
			if (args.includes("device")) {
				if (observation.pending && !named) return "30\n";
				const values = requested.map((field) =>
					field === "GENERAL.STATE"
						? observation.active && !observation.pending
							? "100"
							: "30"
						: field === "GENERAL.CON-UUID"
							? (observation.active ?? "")
							: activePath,
				);
				return named
					? requested
							.map((field, index) => `${field}:${values[index] ?? ""}`)
							.join("\n")
					: values.join("\n");
			}
			const uuid = args.at(-1) ?? "";
			if (!profiles.has(uuid)) throw new Error("Unknown connection");
			if (requested.includes("GENERAL.FILENAME"))
				throw Object.assign(
					new Error("nmcli invalid connection detail field"),
					{
						code: 2,
						stdout: "",
						stderr:
							"Error: 'connection show': invalid field 'GENERAL.FILENAME'",
					},
				);
			const values = settings.get(uuid) ?? {
				"802-11-wireless.mode": "infrastructure",
				"802-11-wireless.ssid": "Unrelated",
				"802-11-wireless.mac-address": "dc:a6:32:aa:bb:ff",
			};
			const rendered = requested.map((field) => {
				if (field === "802-11-wireless-security.psk-flags")
					return values[field] ?? "0";
				if (field === "connection.type")
					return (
						values[field] ?? (values.type === "wifi" ? "802-11-wireless" : "")
					);
				const value =
					field === "802-11-wireless.mode" && uuid === observation.active
						? observation.mode
						: (values[field] ??
							(field === "connection.autoconnect-priority" ? "999" : ""));
				if (field === "802-11-wireless-security.pmf") {
					const labels: Record<string, string> = {
						"0": "0 (default)",
						default: "0 (default)",
						"1": "1 (disable)",
						disable: "1 (disable)",
						"2": "2 (optional)",
						optional: "2 (optional)",
						"3": "3 (required)",
						required: "3 (required)",
					};
					return labels[value] ?? value;
				}
				return value;
			});
			return named
				? `${requested
						.flatMap((field, index) =>
							field === "match.path" && !Object.hasOwn(values, field)
								? []
								: [`${field}:${rendered[index] ?? ""}`],
						)
						.join("\n")}\n`
				: rendered.join("\n");
		},
	};
}

export async function replayFirstApState(input: object): Promise<unknown> {
	const profilePaths = (await nmConnsGet("uuid,dbus-path"))
		?.filter(Boolean)
		.map(nmcliParseSep);
	const profileFiles = (await nmConnsGet("uuid,filename"))
		?.filter(Boolean)
		.map(nmcliParseSep);
	const child = Bun.spawn(
		[
			process.execPath,
			"test",
			"--timeout",
			"15000",
			"./apps/backend/src/tests/helpers/wifi-first-ap-restart.ts",
		],
		{
			cwd: resolve(import.meta.dir, "../../../../.."),
			env: process.env,
			stdin: new Response(
				JSON.stringify({ ...input, profilePaths, profileFiles }),
			),
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stdout = await new Response(child.stdout).text();
	const diagnostic = await new Response(child.stderr).text();
	if (await child.exited) throw new Error(diagnostic);
	return JSON.parse(stdout.trim().split("\n").at(-1) ?? "");
}
