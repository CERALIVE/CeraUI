import { expect, test } from "bun:test";
import { osInstallClientsGone } from "../modules/system/update-orchestrator/os-stage-install-clients.ts";
import { realDeviceSection } from "./helpers/real-device-fixture.ts";

const url = "https://images.ceralive.tv/bundle.raucb";
test.each(
	[
		["--debug"],
		["-d"],
		["--conf", "/etc/rauc/system.conf"],
		["-C", "/etc/rauc/system.conf"],
		["--keyring", "/etc/rauc/keyring.pem"],
		["--override-boot-slot", "A"],
		["--conf=/etc/rauc/system.conf"],
		["--debug", "--keyring=/etc/rauc/keyring.pem", "--override-boot-slot=B"],
		["--"],
	].map((options) => ({ options })),
)("global flags %j never hide an installer", async ({ options }) => {
	const deps = {
		list: async () => ["123"],
		read: async () =>
			["/usr/bin/rauc", ...options, "install", url, ""].join("\0"),
	};
	expect(await osInstallClientsGone(undefined, deps)).toBe(false);
	expect(await osInstallClientsGone(url, deps)).toBe(false);
});

test.each(
	[
		["--future", "install", url],
		["--conf"],
		["--conf", "--debug", "install", url],
		[],
		["--debug"],
		["unknown-command"],
		["install", "--future", url],
	].map((tail) => ({ tail })),
)("ambiguous RAUC argv %j refuses installer exclusion", async ({ tail }) => {
	const deps = {
		list: async () => ["123"],
		read: async () => ["rauc", ...tail, ""].join("\0"),
	};
	expect(await osInstallClientsGone(url, deps)).toBe(false);
});

test("another URL's flagged installer is still present in an unrestricted scan", async () => {
	const deps = {
		list: async () => ["123"],
		read: async () => `rauc\0-d\0install\0${url}\0`,
	};
	expect(await osInstallClientsGone(undefined, deps)).toBe(false);
	expect(
		await osInstallClientsGone("https://images.ceralive.tv/other.raucb", deps),
	).toBe(true);
});

test("the captured real service argv proves non-installer exclusion", async () => {
	const line =
		(await realDeviceSection("rock-readonly", "b2-clients"))
			.trim()
			.split("\n")[0] ?? "";
	const encoded = line.trim().split(/\s+/).at(-1) ?? "";
	const raw = Buffer.from(encoded, "base64").toString();
	expect(raw).toContain("service");
	expect(
		await osInstallClientsGone(undefined, {
			list: async () => ["656"],
			read: async () => raw,
		}),
	).toBe(true);
});
