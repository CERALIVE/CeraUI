import { expect, spyOn, test } from "bun:test";
import { statSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as exec from "../helpers/exec.ts";
import * as runner from "../helpers/run.ts";
import {
	nmConnDelete,
	nmConnect,
	nmConnSetFields,
	nmDeviceProp,
	nmDevices,
	nmDisconnect,
} from "../modules/network/network-manager.ts";
import { prepareHotspotForInterface } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	wifiHotspotConfig,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { settlePending } from "../modules/wifi/wifi-hotspot-monitor.ts";
import { statusClient } from "./helpers/status-client.ts";
import { firstAp } from "./helpers/wifi-first-ap-fixture.ts";

const stdinRunner = runner.runWithStdin;

test.each([
	["nmDevices", () => nmDevices("device,type")],
	["nmDeviceProp", () => nmDeviceProp("wlan0", "GENERAL.CONNECTION")],
	["nmDeviceProp", () => nmDeviceProp("wlan0", "GENERAL.TEST-INVALID")],
] as const)(
	"failed %s does not log private device diagnostics",
	async (name, invoke) => {
		const f = await firstAp();
		try {
			const ssid = "private-device-ssid-sentinel";
			const password = "private-device-psk-sentinel";
			const stderr = `invalid field: ${ssid} ${password}`;
			spyOn(exec, "execFileP").mockRejectedValue(
				Object.assign(new Error(stderr), { code: 2, stderr }),
			);
			expect(await invoke()).toBeUndefined();
			expect(f.logs.some((line) => line.includes(name))).toBe(true);
			expect(f.logs.join("\n")).not.toContain(ssid);
			expect(f.logs.join("\n")).not.toContain(password);
		} finally {
			await f.restore();
		}
	},
);

test.each([
	["nmConnect", "up", nmConnect],
	["nmDisconnect", "down", nmDisconnect],
	["nmConnDelete", "del", nmConnDelete],
] as const)(
	"failed %s never logs credentials echoed by nmcli",
	async (name, verb, command) => {
		const f = await firstAp();
		const ssid = "activation-private-ssid";
		const password = "activation-private-passphrase";
		try {
			const stderr = `Cannot activate ${ssid}; rejected passphrase ${password}`;
			const child = spyOn(exec, "execFileP").mockRejectedValue(
				Object.assign(new Error(stderr), { code: 4, stderr }),
			);
			expect(await command("saved-ap")).toBe(false);
			expect(child).toHaveBeenCalledWith(
				"nmcli",
				["conn", verb, "saved-ap"],
				expect.anything(),
			);
			expect(f.logs.some((line) => line.includes(name))).toBe(true);
			expect(
				f.logs.some((line) => line.includes(ssid) || line.includes(password)),
			).toBe(false);
		} finally {
			await f.restore();
		}
	},
);

test("first AP persists its credential without exposing it in any process argv", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing first AP");
		expect(
			f.settings.get(uuid)?.["802-11-wireless-security.psk"] === f.secret,
		).toBe(true);
		expect(f.active()).toBe(uuid);
		expect(statSync(f.nm.files.filename(uuid)).mode & 0o777).toBe(0o600);
		expect(
			f.commands.some((args) => args.some((arg) => arg.includes(f.secret))),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);
		expect(f.logs.some((message) => message.includes("First AP"))).toBe(false);
	} finally {
		await f.restore();
	}
});

test("the actual stdin child environment and argv omit its decoded PSK", async () => {
	const f = await firstAp();
	const root = await mkdtemp(join(tmpdir(), "nm-stdin-contract-"));
	const path = process.env.PATH;
	const trace = join(root, "trace.jsonl");
	try {
		const script = `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import { decodeProfile, encodeProfile } from ${JSON.stringify(new URL("./helpers/wifi-first-ap-keyfile-codec.ts", import.meta.url).pathname)};
const fields = decodeProfile(await Bun.stdin.text());
const secret = fields["802-11-wireless-security.psk"];
await appendFile(${JSON.stringify(trace)}, JSON.stringify({
  argvClean: !process.argv.some(arg => secret && arg.includes(secret)),
  environmentClean: !Object.values(process.env).some(value => secret && value?.includes(secret))
})+"\\n", {mode:0o600});
for(let i=5;i<process.argv.length;i+=2) fields[process.argv[i]]=process.argv[i+1];
process.stdout.write(encodeProfile(fields));
`;
		await writeFile(join(root, "nmcli"), script, { mode: 0o700 });
		await chmod(join(root, "nmcli"), 0o700);
		process.env.PATH = `${root}:${path ?? ""}`;
		spyOn(runner, "runWithStdin").mockImplementation(stdinRunner);

		expect((await f.start()).success).toBe(true);

		const observations = (await readFile(trace, "utf8"))
			.trim()
			.split("\n")
			.map((line: string) => JSON.parse(line));
		expect(observations.length === 0).toBe(false);
		expect(
			observations.every((value) => value.argvClean && value.environmentClean),
		).toBe(true);
		expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);

		const uuid = f.created();
		if (!uuid) throw new Error("Missing saved AP");
		const ssid = "Private saved SSID via stdin";
		const password = `${f.secret}-private-update`;
		expect(
			await nmConnSetFields(uuid, {
				"802-11-wireless.ssid": ssid,
				"802-11-wireless-security.psk": password,
			}),
		).toBe(true);
		expect(f.settings.get(uuid)?.["802-11-wireless.ssid"]).toBe(ssid);
		expect(
			f.logs.some((line) => line.includes(ssid) || line.includes(password)),
		).toBe(false);
	} finally {
		if (path === undefined) delete process.env.PATH;
		else process.env.PATH = path;
		await f.restore();
		await rm(root, { recursive: true, force: true });
	}
});

test("an SSID-only profile update does not log the submitted SSID", async () => {
	const f = await firstAp();
	const ssid = "Synthetic private SSID";
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing saved AP");
		f.logs.length = 0;
		expect(await nmConnSetFields(uuid, { "802-11-wireless.ssid": ssid })).toBe(
			true,
		);
		expect(f.settings.get(uuid)?.["802-11-wireless.ssid"]).toBe(ssid);
		expect(
			f.logs.some((line) => line.includes(ssid) || line.includes(f.secret)),
		).toBe(false);
	} finally {
		await f.restore();
	}
});

for (const failure of [false, true]) {
	test(`Save and ${failure ? "rollback" : "commit"} inherit the protected secret writer`, async () => {
		const f = await firstAp();
		try {
			expect((await f.start()).success).toBe(true);
			await settlePending("wlan0", true);
			const uuid = f.created();
			if (!uuid) throw new Error("Missing saved profile");
			f.row.hotspot.channel = "auto";
			const secret = `${f.secret}-save`;
			f.commands.length = 0;
			const frames: string[] = [];
			let first = true;
			await wifiHotspotConfig(
				statusClient((frame) => frames.push(frame)),
				{
					device: 0,
					name: "Saved AP",
					password: secret,
					channel: "auto",
				},
				{
					...defaultHotspotConfigDeps,
					nmConnSetFields,
					nmConnect: async () => {
						if (first && failure) {
							first = false;
							return false;
						}
						return true;
					},
					wifiUpdateSavedConns: async () => undefined,
					broadcastState: () => undefined,
					rememberCredentials: () => undefined,
					getCapabilities: () => undefined,
				},
			);
			const saved = f.settings.get(uuid)?.["802-11-wireless-security.psk"];
			expect(saved === (failure ? f.secret : secret)).toBe(true);
			expect(
				f.commands.some((args) =>
					args.some((arg) => arg.includes(f.secret) || arg.includes(secret)),
				),
			).toBe(false);
			expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);
			expect(frames.length === 0).toBe(false);
		} finally {
			await f.restore();
		}
	});
}

test("existing-profile credential repair inherits the protected writer", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing saved profile");
		f.row.conn = f.row.activeConn = null;
		delete f.row.activeMode;
		f.observe(undefined, "ap");
		const secret = `${f.secret}-repair`;
		f.commands.length = 0;
		const result = await prepareHotspotForInterface(
			"dc:a6:32:aa:bb:c0",
			f.row,
			{ name: "Repaired AP", password: secret },
			f.deps,
		);
		expect(result.success).toBe(true);
		expect(
			f.settings.get(uuid)?.["802-11-wireless-security.psk"] === secret,
		).toBe(true);
		expect(
			f.commands.some((args) => args.some((arg) => arg.includes(secret))),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(secret))).toBe(false);
	} finally {
		await f.restore();
	}
});

test("an existing profile with a missing NM secret is repaired before connection", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing secret-repair profile");
		const fields = f.settings.get(uuid);
		if (!fields) throw new Error("Missing saved settings");
		fields["802-11-wireless-security.psk"] = "";
		f.nm.files.write(uuid);
		delete f.row.hotspot.password;
		f.row.conn = f.row.activeConn = null;
		delete f.row.activeMode;
		f.observe(undefined, "ap");
		f.commands.length = 0;

		const repaired = await prepareHotspotForInterface(
			"dc:a6:32:aa:bb:c0",
			f.row,
			{},
			f.deps,
		);

		expect(repaired.success).toBe(true);
		expect(
			f.settings.get(uuid)?.["802-11-wireless-security.psk"] === f.secret,
		).toBe(true);
		expect((await f.start()).success).toBe(true);
		expect(f.active()).toBe(uuid);
		expect(
			f.commands.some((args) => args.some((arg) => arg.includes(f.secret))),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);
	} finally {
		await f.restore();
	}
});

test("a failed missing-secret repair keeps its cache unresolved for the next attempt", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		await settlePending("wlan0", true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing failed repair profile");
		const fields = f.settings.get(uuid);
		if (!fields) throw new Error("Missing failed repair settings");
		fields["802-11-wireless-security.psk"] = "";
		f.nm.files.write(uuid);
		delete f.row.hotspot.password;
		f.row.conn = f.row.activeConn = null;
		delete f.row.activeMode;
		f.observe(undefined, "ap");
		spyOn(runner, "runWithStdin").mockRejectedValue(
			new Error("Offline refused"),
		);

		const repaired = await prepareHotspotForInterface(
			"dc:a6:32:aa:bb:c0",
			f.row,
			{},
			f.deps,
		);

		expect(repaired.success).toBe(false);
		expect(f.row.hotspot.password).toBeUndefined();
		expect(f.settings.get(uuid)?.["802-11-wireless-security.psk"]).toBe("");
	} finally {
		await f.restore();
	}
});

test("the shared profile update keeps a replacement credential out of argv", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing saved AP");
		const next = `${f.secret} ';\\`;
		f.commands.length = 0;

		expect(
			await nmConnSetFields(uuid, {
				"802-11-wireless.ssid": "Saved AP",
				"802-11-wireless-security.psk": next,
			}),
		).toBe(true);

		expect(
			f.settings.get(uuid)?.["802-11-wireless-security.psk"] === next,
		).toBe(true);
		expect(
			f.commands.some((args) => args.some((arg) => arg.includes(next))),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(next))).toBe(false);
		expect(f.logs.some((message) => message.includes("Saved AP"))).toBe(false);
	} finally {
		await f.restore();
	}
});

test("profile command failure diagnostics cannot echo the submitted credential", async () => {
	const f = await firstAp();
	try {
		spyOn(exec, "execFileP").mockImplementation(async () => {
			throw new Error(`Synthetic command failure carrying ${f.secret}`);
		});
		expect(
			await nmConnSetFields("test-profile", {
				"802-11-wireless-security.psk": f.secret,
			}),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);
	} finally {
		await f.restore();
	}
});

test("stdin command failure diagnostics cannot echo the submitted credential", async () => {
	const f = await firstAp();
	try {
		expect((await f.start()).success).toBe(true);
		const uuid = f.created();
		if (!uuid) throw new Error("Missing stdin failure profile");
		spyOn(runner, "runWithStdin").mockRejectedValue(
			new Error(`Synthetic private stdin error ${f.secret}`),
		);
		expect(
			await nmConnSetFields(uuid, {
				"802-11-wireless-security.psk": f.secret,
			}),
		).toBe(false);
		expect(f.logs.some((message) => message.includes(f.secret))).toBe(false);
	} finally {
		await f.restore();
	}
});
