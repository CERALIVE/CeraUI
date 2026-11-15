import { expect, test } from "bun:test";
import {
	getPendingHotspotCreation,
	getPendingHotspotCreationInstance,
} from "../modules/wifi/hotspot-credentials.ts";
import { firstAp, MAC } from "./helpers/wifi-first-ap-fixture.ts";

for (const [field, value] of [
	["802-11-wireless.ssid", "Operator AP"],
	["802-11-wireless-security.psk", "operator-credential"],
	["802-11-wireless-security.key-mgmt", "sae"],
	["802-11-wireless-security.pmf", "required"],
	["802-11-wireless.mac-address", "dc:a6:32:aa:bb:ff"],
	["connection.interface-name", "wlan-other"],
	["connection.autoconnect", "yes"],
] as const) {
	test(`add readback rejects a same-UUID replacement with different ${field}`, async () => {
		const f = await firstAp("up");
		let replacedAt = -1;
		f.faults.afterAdd = async () => {
			const uuid = f.created();
			if (!uuid) throw new Error("Missing submitted UUID");
			const settings = f.settings.get(uuid);
			if (!settings) throw new Error("Missing submitted settings");
			settings[field] = value;
			f.nm.files.write(uuid);
			f.observe(uuid, "ap");
			f.autoconnect.add(uuid);
			replacedAt = f.commands.length;
		};
		try {
			expect((await f.start()).success).toBe(false);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing replaced profile");
			expect(f.profiles.has(uuid)).toBe(true);
			expect(f.active()).toBe(uuid);
			expect(f.autoconnect.has(uuid)).toBe(true);
			expect(
				f.commands
					.slice(replacedAt)
					.some(
						(args) =>
							args.includes(uuid) &&
							args.some((arg) => ["up", "down", "del", "modify"].includes(arg)),
					),
			).toBe(false);
			expect(getPendingHotspotCreation(MAC)).toBeUndefined();
			expect(getPendingHotspotCreationInstance(MAC)).toBeUndefined();
		} finally {
			await f.restore();
		}
	});
}

test("Start carries the checked add receipt across a replacement after add returns", async () => {
	const f = await firstAp("up");
	const add = f.deps.nmApConnAdd;
	let replacedAt = -1;
	f.deps.nmApConnAdd = async (...args) => {
		const uuid = await add(...args);
		if (uuid) {
			f.replace(uuid, "Operator after receipt");
			f.observe(uuid, "ap");
			f.autoconnect.add(uuid);
			replacedAt = f.commands.length;
		}
		return uuid;
	};
	try {
		expect((await f.start()).success).toBe(false);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing checked add");
		expect(f.profiles.has(uuid)).toBe(true);
		expect(f.active()).toBe(uuid);
		expect(
			f.commands
				.slice(replacedAt)
				.some(
					(args) =>
						args.includes(uuid) &&
						args.some((arg) => ["up", "down", "del", "modify"].includes(arg)),
				),
		).toBe(false);
		expect(getPendingHotspotCreationInstance(MAC)).toBeUndefined();
	} finally {
		await f.restore();
	}
});
