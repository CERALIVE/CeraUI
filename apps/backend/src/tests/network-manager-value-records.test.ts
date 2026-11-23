import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import {
	nmConnGetFields,
	nmDeviceProp,
} from "../modules/network/network-manager.ts";

afterEach(() => mock.restore());

for (const [fields, stdout, values] of [
	// Debian nmcli 1.52.1, with both frequency capability bits set.
	["WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ", "yes\nyes\n", ["yes", "yes"]],
	["GENERAL.IP-IFACE", "wwan2\n", ["wwan2"]],
	["GENERAL.IP-IFACE", "wwan2", ["wwan2"]],
	["GENERAL.IP-IFACE", "", [""]],
	["GENERAL.IP-IFACE", "\n", [""]],
	[
		"GENERAL.STATE,GENERAL.CON-UUID,GENERAL.CON-PATH",
		"30\n\n--\n",
		["30", "", "--"],
	],
	["WIFI-PROPERTIES.2GHZ,WIFI-PROPERTIES.5GHZ", "yes\n\n", ["yes", ""]],
	// The Linux producer uses LF. Preserve whitespace, including a literal CR.
	["GENERAL.CONNECTION", "name \r\n", ["name \r"]],
] as const) {
	test(`device values preserve records in ${JSON.stringify(stdout)}`, async () => {
		const command = spyOn(exec, "execFileP").mockResolvedValue({
			stdout,
			stderr: "",
		});
		expect(await nmDeviceProp("wlan1", fields)).toEqual([...values]);
		expect(command.mock.calls[0]?.[1]).toEqual([
			"--terse",
			"--escape",
			"no",
			"--get-values",
			fields,
			"device",
			"show",
			"wlan1",
		]);
	});
}

test("a fixed profile tuple preserves its empty final field", async () => {
	spyOn(exec, "execFileP").mockResolvedValue({ stdout: "ap\n\n", stderr: "" });
	expect(
		await nmConnGetFields("test-ap", [
			"802-11-wireless.mode",
			"802-11-wireless.ssid",
		]),
	).toEqual(["ap", ""]);
});
