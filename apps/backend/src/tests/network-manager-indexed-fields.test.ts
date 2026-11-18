import { afterEach, expect, mock, spyOn, test } from "bun:test";
import * as exec from "../helpers/exec.ts";
import { nmDeviceProp } from "../modules/network/network-manager.ts";

afterEach(() => mock.restore());

const mac = "02:00:00:00:01:00";
for (const [addresses, expected] of [
	["IP4.ADDRESS[1]:10.42.0.1/24\n", "10.42.0.1/24"],
	[
		"IP4.ADDRESS[1]:10.42.0.1/24\nIP4.ADDRESS[2]:192.0.2.1/24\n",
		"10.42.0.1/24\n192.0.2.1/24",
	],
	["", ""],
] as const) {
	test(`mixed-section device observation retains indexed IPv4: ${JSON.stringify(addresses)}`, async () => {
		spyOn(exec, "execFileP").mockResolvedValue({
			stdout: `GENERAL.HWADDR:${mac}\n${addresses}`,
			stderr: "",
		});
		expect(await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP4.ADDRESS")).toEqual([
			mac,
			expected,
		]);
	});
}

test("named multiline mode retains indexed IPv6 labels and literal values", async () => {
	spyOn(exec, "execFileP").mockResolvedValue({
		stdout: `GENERAL.HWADDR:${mac}\nIP6.ADDRESS[1]:2001:db8::1/64\nIP6.ADDRESS[2]:fe80::1/64\n`,
		stderr: "",
	});
	expect(
		await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP6.ADDRESS", "multiline"),
	).toEqual([
		`GENERAL.HWADDR:${mac}`,
		"IP6.ADDRESS[1]:2001:db8::1/64",
		"IP6.ADDRESS[2]:fe80::1/64",
	]);
	expect(await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP6.ADDRESS")).toEqual([
		mac,
		"2001:db8::1/64\nfe80::1/64",
	]);
});

test("base-field projection preserves continuation lines and indexed order", async () => {
	spyOn(exec, "execFileP").mockResolvedValue({
		stdout:
			"GENERAL.CONNECTION: Office:\\ \ncontinued\n\nIP4.ADDRESS[2]:192.0.2.2/24\nIP4.ADDRESS[1]:10.42.0.1/24\n",
		stderr: "",
	});
	expect(await nmDeviceProp("wlan1", "GENERAL.CONNECTION,IP4.ADDRESS")).toEqual(
		[" Office:\\ \ncontinued\n", "192.0.2.2/24\n10.42.0.1/24"],
	);
});

test("duplicate indexed labels still reject the entire observation", async () => {
	spyOn(exec, "execFileP").mockResolvedValue({
		stdout: `GENERAL.HWADDR:${mac}\nIP4.ADDRESS[1]:10.42.0.1/24\nIP4.ADDRESS[1]:192.0.2.1/24\n`,
		stderr: "",
	});
	expect(
		await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP4.ADDRESS"),
	).toBeUndefined();
});

for (const [first, second] of [
	["IP4.ADDRESS[1]", "IP4.ADDRESS[01]"],
	["IP4.ADDRESS[002]", "ip4.address[2]"],
	["IP4.ADDRESS", "IP4.ADDRESS[1]"],
	["IP4.ADDRESS[01]", "IP4.ADDRESS"],
	["IP6.ADDRESS[1]", "IP6.ADDRESS[001]"],
	["IP6.ADDRESS", "IP6.ADDRESS[1]"],
] as const) {
	test(`logical duplicate labels refuse the observation: ${first} and ${second}`, async () => {
		spyOn(exec, "execFileP").mockResolvedValue({
			stdout: `GENERAL.HWADDR:${mac}\n${first}:first\n${second}:second\n`,
			stderr: "",
		});
		expect(
			await nmDeviceProp(
				"wlan1",
				`GENERAL.HWADDR,${first.startsWith("IP4") ? "IP4" : "IP6"}.ADDRESS`,
			),
		).toBeUndefined();
	});
}

test("canonical duplicate detection preserves distinct large indices and original named labels", async () => {
	spyOn(exec, "execFileP").mockResolvedValue({
		stdout: `GENERAL.HWADDR:${mac}\nIP4.ADDRESS[01]:first\nIP4.ADDRESS[9007199254740992]:second\nIP4.ADDRESS[9007199254740993]:third\n`,
		stderr: "",
	});
	expect(await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP4.ADDRESS")).toEqual([
		mac,
		"first\nsecond\nthird",
	]);
	expect(
		await nmDeviceProp("wlan1", "GENERAL.HWADDR,IP4.ADDRESS", "multiline"),
	).toEqual([
		`GENERAL.HWADDR:${mac}`,
		"IP4.ADDRESS[01]:first",
		"IP4.ADDRESS[9007199254740992]:second",
		"IP4.ADDRESS[9007199254740993]:third",
	]);
});
