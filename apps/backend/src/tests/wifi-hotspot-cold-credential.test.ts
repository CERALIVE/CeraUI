import { expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import * as exec from "../helpers/exec.ts";
import {
	getHotspotCredentials,
	initHotspotCredentials,
	rememberHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { replaceNmcliField } from "./helpers/nmcli-field-output.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

const persistedCredentials = z.object({
	adapters: z.record(z.string(), z.object({ password: z.string() })),
});

for (const display of [
	"stale",
	"correct",
	"noncanonical",
	"hidden",
	"empty",
	"unavailable",
] as const) {
	test(`true cold credential hydration verifies the ${display} display read`, async () => {
		const f = await firstAp();
		const root = await mkdtemp(join(tmpdir(), "cold-hotspot-credential-"));
		const path = join(root, "hotspot_credentials.json");
		const stale = "unpersisted-cold-credential-sentinel";
		try {
			expect((await f.start()).success).toBe(true);
			await settlePending("wlan0", true);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing cold-hydration AP");
			if (display === "noncanonical")
				await writeFile(
					f.nm.files.filename(uuid),
					`# Preserved operator formatting\n${await readFile(f.nm.files.filename(uuid), "utf8")}`,
				);
			const keyfile = await readFile(f.nm.files.filename(uuid));
			await writeFile(path, JSON.stringify({ version: 2, adapters: {} }), {
				mode: 0o600,
			});
			await initHotspotCredentials(path);
			delete f.row.hotspot.password;
			f.row.activeConn = uuid;
			f.row.activeMode = "ap";
			expect(getHotspotCredentials(MAC)).toBeUndefined();
			let initialRead = 0;
			const boundary = spyOn(exec, "execFileP").getMockImplementation();
			if (!boundary) throw new Error("Missing cold NM boundary");
			spyOn(exec, "execFileP").mockImplementation(
				async (binary, args, options) => {
					const output = await boundary(binary, args, options);
					const selector = Math.max(
						args?.indexOf("--get-values") ?? -1,
						args?.indexOf("--fields") ?? -1,
					);
					const fields = args?.[selector + 1]?.split(",") ?? [];
					const secret = fields.indexOf("802-11-wireless-security.psk");
					if (
						initialRead ||
						selector < 0 ||
						secret < 0 ||
						fields[0] !== "connection.autoconnect-priority" ||
						!args?.includes(uuid)
					)
						return output;
					initialRead++;
					if (display === "unavailable")
						throw new Error("Synthetic unavailable secret");
					const observed =
						display === "stale"
							? stale
							: display === "hidden"
								? "<hidden>"
								: display === "empty"
									? ""
									: f.secret;
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
			await handleHotspotConn(MAC, uuid, { active: true });
			const persisted = persistedCredentials.parse(
				JSON.parse(await readFile(path, "utf8")),
			);
			const published = wifiBuildMsg()[f.row.id]?.hotspot?.password;
			const stored = getHotspotCredentials(MAC)?.password;
			const disk = persisted.adapters[MAC]?.password;
			const expected =
				display === "stale" ||
				display === "correct" ||
				display === "noncanonical"
					? f.secret
					: undefined;
			expect(initialRead).toBe(1);
			expect({
				publishedMatchesExpected: published === expected,
				storedUnclaimed: stored === undefined,
				persistedUnclaimed: disk === undefined,
				publishedStale: published === stale,
				storedStale: stored === stale,
				persistedStale: disk === stale,
				keyfilePreserved: (await readFile(f.nm.files.filename(uuid))).equals(
					keyfile,
				),
			}).toEqual({
				publishedMatchesExpected: true,
				storedUnclaimed: true,
				persistedUnclaimed: true,
				publishedStale: false,
				storedStale: false,
				persistedStale: false,
				keyfilePreserved: true,
			});

			const oldPassword = `${f.secret}-previously-recorded`;
			rememberHotspotCredentials(MAC, {
				conn: uuid,
				ssid: "First AP",
				password: oldPassword,
			});
			await initHotspotCredentials(path);
			delete f.row.hotspot.password;
			initialRead = 0;
			await handleHotspotConn(MAC, uuid, { active: true });
			const ownedDisk = persistedCredentials.parse(
				JSON.parse(await readFile(path, "utf8")),
			);
			const ownedExpected = expected ?? oldPassword;
			expect(initialRead).toBe(1);
			expect(wifiBuildMsg()[f.row.id]?.hotspot?.password).toBe(
				display === "unavailable" ? undefined : ownedExpected,
			);
			expect(getHotspotCredentials(MAC)?.password).toBe(ownedExpected);
			expect(ownedDisk.adapters[MAC]?.password).toBe(ownedExpected);
			expect((await readFile(f.nm.files.filename(uuid))).equals(keyfile)).toBe(
				true,
			);
		} finally {
			await f.restore();
			await rm(root, { recursive: true });
		}
	});
}
