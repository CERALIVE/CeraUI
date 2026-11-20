import { expect, spyOn, test } from "bun:test";
import { withWifiRequestBinding } from "../modules/wifi/wifi-binding.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { firstAp, MAC, OTHER_UUID } from "./helpers/wifi-first-ap-fixture.ts";

for (const { hybrid, security } of [
	{ hybrid: false, security: "wpa2" },
	{ hybrid: false, security: "wpa3-sae" },
	{ hybrid: true, security: "wpa2" },
] as const) {
	test(`(1) first AP is added once, inactive and bound, hybrid=${hybrid}, security=${security}`, async () => {
		const f = await firstAp(undefined, hybrid);
		f.row.hotspot.security = security;
		try {
			expect(await f.start()).toEqual({ success: true });
			expect(
				f.commands.some((args) => args.some((arg) => arg.includes(f.secret))),
			).toBe(false);
			expect(
				f.settings.get(f.created() ?? "")?.["802-11-wireless-security.psk"] ===
					f.secret,
			).toBe(true);
			expect(f.commands.filter((a) => a[1] === "add")).toHaveLength(1);
			expect(f.commands.some((a) => a.includes("hotspot"))).toBe(false);
			expect(f.fields()).toMatchObject({
				type: "wifi",
				"802-11-wireless.mode": "ap",
				"ipv4.method": "shared",
				"ipv6.method": "ignore",
				"802-11-wireless-security.key-mgmt":
					security === "wpa3-sae" ? "sae" : "wpa-psk",
				"802-11-wireless-security.proto": "rsn",
				"802-11-wireless-security.pairwise": "ccmp",
				"802-11-wireless-security.group": "ccmp",
				"802-11-wireless-security.pmf":
					security === "wpa3-sae" ? "required" : "disable",
				"802-11-wireless-security.psk": "<redacted>",
				"connection.interface-name": hybrid ? "clap-wlan0" : "",
				"802-11-wireless.mac-address": hybrid ? "" : MAC,
				"connection.autoconnect": "no",
				"connection.uuid": f.created(),
			});
			expect(f.created()).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(f.active()).toBe(f.created());
		} finally {
			await f.restore();
		}
	});
}

test("(2) lock-entry admission finishes before any add or up", async () => {
	const f = await firstAp();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let paused = false;
	spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) => {
		if (!paused) {
			paused = true;
			entered.resolve();
			await release.promise;
		}
		return path.endsWith("/ifindex")
			? "10"
			: path.endsWith("/index")
				? "1"
				: MAC;
	});
	try {
		const start = withWifiRequestBinding(
			{ device: "0", expected: f.before, kind: "config" },
			f.start,
		);
		await entered.promise;
		expect(f.commands).toEqual([]);
		expect(f.active()).toBeUndefined();
		release.resolve();
		expect(await start).toEqual({ success: true });
		expect(f.commands[0]?.slice(0, 2)).toEqual(["connection", "add"]);
	} finally {
		release.resolve();
		await f.restore();
	}
});

for (const failure of ["ownership", "uuid", "up"] as const) {
	test(`(3) ${failure} refusal deletes only the recorded new UUID`, async () => {
		const f = await firstAp(failure);
		try {
			expect(await f.start()).toEqual({
				success: false,
				error: "activation-failed",
			});
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created profile");
			expect(f.commands.filter((a) => a[1] === "del")).toEqual([
				["conn", "del", uuid],
			]);
			expect([...f.profiles]).toEqual([OTHER_UUID]);
			expect(f.active()).toBeUndefined();
			expect(f.row.hotspot.conn).toBeUndefined();
			if (failure !== "up")
				expect(f.commands.some((a) => a.includes("up"))).toBe(false);
		} finally {
			await f.restore();
		}
	});
}

for (const failure of [undefined, "add", "receipt"] as const) {
	test(`(4) runner and failure logs exclude the passphrase, outcome=${failure}`, async () => {
		const f = await firstAp(failure);
		try {
			expect((await f.start()).success).toBe(failure === undefined);
			expect(f.logs.some((line) => line.startsWith("run: nmcli"))).toBe(true);
			expect(f.logs.some((line) => line.includes(f.secret))).toBe(false);
		} finally {
			await f.restore();
		}
	});
}

for (const failure of [
	"ownership-up",
	"ownership-autoconnect",
	"autoconnect",
	"post-up-throw",
] as const) {
	test(`review: ${failure} rolls back the active new UUID until success is accepted`, async () => {
		const f = await firstAp(failure);
		try {
			const result = await f.start().then(
				(value) => value,
				(error: unknown) => error,
			);
			if (failure === "post-up-throw") {
				expect(result).toBeInstanceOf(Error);
				expect(result).toHaveProperty("message", "Post-up persistence failed");
			} else {
				expect(result).toEqual({ success: false, error: "activation-failed" });
			}
			const uuid = f.created();
			if (!uuid) throw new Error("Missing created profile");
			expect(
				f.commands.filter((a) => a[1] === "down" || a[1] === "del"),
			).toEqual([
				["conn", "down", uuid],
				["conn", "del", uuid],
			]);
			expect([...f.profiles]).toEqual([OTHER_UUID]);
			expect(f.active()).toBeUndefined();
			expect([...f.autoconnect]).toEqual([]);
			if (failure === "ownership-up" || failure === "ownership-autoconnect")
				expect(f.row.hotspot.conn).toBe(OTHER_UUID);
			else expect(f.row.hotspot.conn).toBeUndefined();
		} finally {
			await f.restore();
		}
	});
}

test("review: an add that creates then throws deletes only its generated UUID", async () => {
	const f = await firstAp("add-after-create");
	try {
		expect(await f.start()).toEqual({
			success: false,
			error: "activation-failed",
		});
		const uuid = f.created();
		if (!uuid) throw new Error("Missing created profile");
		expect(f.commands.filter((a) => a[1] === "del")).toEqual([
			["conn", "del", uuid],
		]);
		expect([...f.profiles]).toEqual([OTHER_UUID]);
		expect(f.active()).toBeUndefined();
		expect(f.row.hotspot.conn).toBeUndefined();
		expect(f.logs.some((line) => line.includes(f.secret))).toBe(false);
	} finally {
		await f.restore();
	}
});

for (const channel of ["auto", "auto_24", "ch_36"] as const) {
	test(`(5) first-start band/channel remain unset as on main, stored=${channel}`, async () => {
		const f = await firstAp();
		f.row.hotspot.channel = channel;
		try {
			expect(await f.start()).toEqual({ success: true });
			expect(f.fields()["802-11-wireless.band"]).toBeUndefined();
			expect(f.fields()["802-11-wireless.channel"]).toBeUndefined();
		} finally {
			await f.restore();
		}
	});
}
