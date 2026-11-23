import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
	getHotspotCredentials,
	initHotspotCredentials,
} from "../modules/wifi/hotspot-credentials.ts";
import { wifiBuildMsg } from "../modules/wifi/wifi.ts";
import { handleHotspotConn } from "../modules/wifi/wifi-hotspot-discovery.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";
import { decodeProfile } from "./helpers/wifi-first-ap-keyfile-codec.ts";

const persistedNames = z.object({
	adapters: z.record(z.string(), z.object({ ssid: z.string().optional() })),
});

test("cold rediscovery preserves or withholds the exact newline-containing keyfile SSID", async () => {
	const f = await firstAp();
	const root = await mkdtemp(join(tmpdir(), "cold-hotspot-name-"));
	const store = join(root, "hotspot_credentials.json");
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		const settings = uuid ? f.settings.get(uuid) : undefined;
		if (!uuid || !settings) throw new Error("Missing cold-name profile");
		const name = "Office\n";
		settings["802-11-wireless.ssid"] = name;
		f.nm.files.write(uuid);
		const filename = f.nm.files.filename(uuid);
		const before = await readFile(filename);
		expect(decodeProfile(before.toString())["802-11-wireless.ssid"]).toBe(name);
		await writeFile(store, JSON.stringify({ version: 2, adapters: {} }), {
			mode: 0o600,
		});
		await initHotspotCredentials(store);
		delete f.row.hotspot.name;
		delete f.row.hotspot.password;
		f.row.activeConn = uuid;
		f.row.activeMode = "ap";
		await handleHotspotConn(MAC, uuid, { active: true });
		const disk = persistedNames.parse(
			JSON.parse(await readFile(store, "utf8")),
		);
		const names = [
			f.row.hotspot.name,
			wifiBuildMsg()[f.row.id]?.hotspot?.name,
			getHotspotCredentials(MAC)?.ssid,
			disk.adapters[MAC]?.ssid,
		];
		expect(names.every((value) => value === undefined || value === name)).toBe(
			true,
		);
		expect((await readFile(filename)).equals(before)).toBe(true);
	} finally {
		await f.restore();
		await rm(root, { recursive: true });
	}
});
