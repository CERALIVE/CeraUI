import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { writeNmWifiSecret } from "../modules/network/network-manager-secret.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

test("a profile replaced during a successful radio check retains its bytes and is never loaded", async () => {
	const f = await firstAp();
	try {
		const started = await f.start();
		const uuid = f.created();
		if (!started.success || !uuid) throw new Error("Missing initial hotspot");
		const filename = f.nm.files.filename(uuid);
		const firstCommand = f.commands.length;
		let replacement: Buffer | undefined;
		const result = await writeNmWifiSecret(
			uuid,
			{ "802-11-wireless-security.psk": "requested-test-password" },
			async () => {
				f.replace(uuid);
				replacement = await readFile(filename);
				return true;
			},
		);
		expect(replacement).toBeDefined();
		expect(await readFile(filename)).toEqual(replacement);
		expect(
			f.commands
				.slice(firstCommand)
				.filter(
					([object, action]) => object === "connection" && action === "load",
				),
		).toEqual([]);
		expect(result).toBeFalse();
	} finally {
		await f.restore();
	}
});
