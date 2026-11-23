import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as exec from "../helpers/exec.ts";
import {
	getHotspotCredentials,
	hotspotCredentialsStore,
	initHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiBuildMsg, wifiUpdateSavedConns } from "../modules/wifi/wifi.ts";
import { prepareHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import { findHotspotConnForAdapter } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { replaceNmcliField } from "./helpers/nmcli-field-output.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

const persisted = z.object({
	adapters: z.record(z.string(), z.object({ password: z.string() })),
});

for (const entry of ["prepare", "start", "prepare-start"] as const) {
	for (const display of ["single-stale", "consistent-stale"] as const) {
		test(`no UUID hint: real ${entry} accepts only persistent credentials, ${display}`, async () => {
			const f = await firstAp();
			const root = await mkdtemp(join(tmpdir(), "hotspot-credential-lookup-"));
			const path = join(root, "hotspot_credentials.json");
			const stale = "unpersisted-lookup-credential-sentinel";
			try {
				expect((await f.start()).success).toBe(true);
				await settlePending("wlan0", true);
				const uuid = f.created();
				if (!uuid) throw new Error("Missing existing native-shaped AP");
				const bytes = await readFile(f.nm.files.filename(uuid));
				await writeFile(
					path,
					JSON.stringify({
						version: 2,
						adapters: {
							[MAC]: {
								ssid: "First AP",
								password: stale,
								previousConns: [uuid],
							},
						},
					}),
					{ mode: 0o600 },
				);
				await initHotspotCredentials(path);
				f.deps.credentials = hotspotCredentialsStore;
				f.deps.findHotspotConn = findHotspotConnForAdapter;
				f.deps.wifiUpdateSavedConns = wifiUpdateSavedConns;
				delete f.row.hotspot.conn;
				delete f.row.hotspot.name;
				delete f.row.hotspot.password;
				f.row.conn = f.row.activeConn = null;
				delete f.row.activeMode;
				f.observe(undefined, "ap");
				const noHint = getHotspotCredentials(MAC)?.conn === undefined;
				const boundary = spyOn(exec, "execFileP").getMockImplementation();
				if (!boundary) throw new Error("Missing lookup NM boundary");
				let replaced = 0;
				spyOn(exec, "execFileP").mockImplementation(
					async (binary, args, options) => {
						const output = await boundary(binary, args, options);
						if (!args?.includes(uuid)) return output;
						const selector = Math.max(
							args.indexOf("--get-values"),
							args.indexOf("--fields"),
						);
						const fields = args[selector + 1]?.split(",") ?? [];
						const secret = fields.indexOf("802-11-wireless-security.psk");
						const lookup =
							fields[0] === "802-11-wireless.mode" && fields.length === 6;
						if (
							selector < 0 ||
							secret < 0 ||
							(display === "single-stale" && (!lookup || replaced !== 0))
						)
							return output;
						replaced++;
						const observed = stale;
						return {
							...output,
							stdout: replaceNmcliField(
								args ?? [],
								output.stdout,
								"802-11-wireless-security.psk",
								observed,
							),
						};
					},
				);
				const prepared =
					entry !== "start"
						? await prepareHotspotForInterface(MAC, f.row, {}, f.deps)
						: undefined;
				const started = entry !== "prepare" ? await f.start() : undefined;
				if (started?.success) await settlePending("wlan0", true);
				const disk = persisted.parse(JSON.parse(await readFile(path, "utf8")));
				expect({
					noHint,
					lookupTampered: replaced > 0,
					prepared: prepared === undefined || prepared.success,
					preparePasswordMatches:
						prepared === undefined ||
						("password" in prepared && prepared.password === f.secret),
					started: started === undefined || started.success,
					publicPasswordMatches:
						started === undefined ||
						wifiBuildMsg()[f.row.id]?.hotspot?.password === f.secret,
					cachedPasswordMatches: f.row.hotspot.password === f.secret,
					storedPasswordMatches:
						started === undefined ||
						getHotspotCredentials(MAC)?.password === f.secret,
					persistedPasswordMatches:
						started === undefined || disk.adapters[MAC]?.password === f.secret,
					credentialUnchanged:
						f.settings.get(uuid)?.["802-11-wireless-security.psk"] === f.secret,
					keyfileUnchanged: (await readFile(f.nm.files.filename(uuid))).equals(
						bytes,
					),
					activeMatchesCreated: started === undefined || f.active() === uuid,
				}).toEqual({
					noHint: true,
					lookupTampered: true,
					prepared: true,
					preparePasswordMatches: true,
					started: true,
					publicPasswordMatches: true,
					cachedPasswordMatches: true,
					storedPasswordMatches: true,
					persistedPasswordMatches: true,
					credentialUnchanged: true,
					keyfileUnchanged: true,
					activeMatchesCreated: true,
				});
			} finally {
				await f.restore();
				await rm(root, { recursive: true });
			}
		});
	}
}

for (const display of ["hidden", "empty", "after-up"] as const) {
	test(`persistent first add and authority ignore secret display visibility: ${display}`, async () => {
		const f = await firstAp();
		try {
			const boundary = spyOn(exec, "execFileP").getMockImplementation();
			if (!boundary) throw new Error("Missing add NM boundary");
			spyOn(exec, "execFileP").mockImplementation(
				async (binary, args, options) => {
					const output = await boundary(binary, args, options);
					if (display === "after-up" && !f.active()) return output;
					const selector = Math.max(
						args?.indexOf("--get-values") ?? -1,
						args?.indexOf("--fields") ?? -1,
					);
					const fields = args?.[selector + 1]?.split(",") ?? [];
					const secret = fields.indexOf("802-11-wireless-security.psk");
					if (selector < 0 || secret < 0) return output;
					const observed = display === "empty" ? "" : "<hidden>";
					return {
						...output,
						stdout: replaceNmcliField(
							args ?? [],
							output.stdout,
							"802-11-wireless-security.psk",
							observed,
						),
					};
				},
			);
			const result = await f.start();
			if (result.success) await settlePending("wlan0", true);
			const uuid = f.created();
			expect({
				started: result.success,
				persisted:
					f.settings.get(uuid ?? "")?.["802-11-wireless-security.psk"] ===
					f.secret,
				active: uuid !== undefined && f.active() === uuid,
			}).toEqual({ started: true, persisted: true, active: true });
		} finally {
			await f.restore();
		}
	});
}
