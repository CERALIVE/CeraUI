import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	getConfig,
	loadConfig,
	saveConfig,
	setConfigFilePath,
} from "../modules/config.ts";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "config-safety-"));
	path = join(dir, "config.json");
	setConfigFilePath(path);
});
afterEach(async () => {
	writeFileSync(path, "{}");
	await loadConfig();
	setConfigFilePath("config.json");
	rmSync(dir, { recursive: true, force: true });
});

test.each([
	'{"modem_provisioning":false,"modem_provisioning":true}',
	'{"modem_capabilities":{"fcc_auto_unlock":false,"fcc_auto_unlock":true}}',
	'{"bond_opt_out":{"usb:a":true},"bond_opt_out":{}}',
	'{"bond_opt_out":{"usb:a":false}}',
	'{"autostart":true',
])(
	"ambiguous runtime config grants no safety permission: %s",
	async (bytes) => {
		// Given ambiguous safety-bearing state in an otherwise preference-tolerant file.
		writeFileSync(path, bytes);
		let grants = 0;
		// When a load and subsequent safety accessor attempt to use it.
		try {
			await loadConfig();
			getConfig();
			grants++;
		} catch (error) {
			expect(error).toBeInstanceOf(Error);
		}
		// Then neither stale/default config nor a save can replace the authority.
		expect(grants).toBe(0);
		expect(() => getConfig()).toThrow();
		expect(() => saveConfig()).toThrow();
		expect(readFileSync(path, "utf8")).toBe(bytes);
	},
);

test("cosmetic preference salvage retains valid safety fields", async () => {
	// Given a bad preference but a valid explicit opt-out and disabled admission.
	writeFileSync(
		path,
		'{"max_br":"bad","modem_provisioning":false,"bond_opt_out":{"usb:a":true}}',
	);
	// When the existing permissive preference loader hydrates it.
	await loadConfig();
	// Then preference defaults do not erase the strict safety projection.
	expect(getConfig().max_br).toBe(5000);
	expect(getConfig().modem_provisioning).toBe(false);
	expect(getConfig().bond_opt_out).toEqual({ "usb:a": true });
});

test("T5: a malformed twin residual prevents load and save rather than lifting an exclusion", async () => {
	writeFileSync(path, '{"bond_group_opt_out":{"group":[]}}');
	await loadConfig();
	const invalid = '{"max_br":"bad","bond_group_opt_out":{"group":"port"}}';
	writeFileSync(path, invalid);
	await expect(loadConfig()).rejects.toThrow(
		"runtime_config_authority_unavailable",
	);
	expect(() => getConfig()).toThrow("runtime_config_authority_unavailable");
	expect(() => saveConfig()).toThrow("runtime_config_authority_unavailable");
	expect(readFileSync(path, "utf8")).toBe(invalid);
});

test("preference salvage preserves empty and nonempty twin residuals across a save and reload", async () => {
	const residual = { excluded: [], split: ["port"] };
	writeFileSync(
		path,
		JSON.stringify({ max_br: "bad", bond_group_opt_out: residual }),
	);
	await loadConfig();
	expect(getConfig().max_br).toBe(5000);
	saveConfig();
	await loadConfig();
	expect(getConfig().bond_group_opt_out).toEqual(residual);
});
