import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	initModemCredentials,
	projectModemCredential,
	readModemCredential,
	resetModemCredentialsForTest,
	writeModemCredential,
} from "../modules/modems/modem-credentials.ts";
import {
	mintLinkId,
	resetPhysicalIdentityRegistry,
	resolvePhysicalDevice,
	setPresentPhysicalDevices,
} from "../modules/modems/physical-identity.ts";
import { resolveModemPhysicalIdentity } from "../modules/modems/physical-identity-source.ts";
import {
	refreshUsbNetMarkers,
	resetUsbNetMarkers,
} from "../modules/network/router-cellular-scan.ts";
import {
	constructedTwinDeps,
	constructedTwins,
} from "./helpers/constructed-usb-twins.ts";

const credential = {
	username: "fixture-owner",
	password: "fixture-only-owner-login",
};
const [first, second] = constructedTwins;
if (first === undefined || second === undefined) {
	throw new Error("constructed twin fixture must contain two devices");
}
let root: string;
let store: string;

beforeEach(async () => {
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	resetUsbNetMarkers();
	root = await mkdtemp(join(tmpdir(), "modem-credential-ownership-"));
	store = join(root, "modem-credentials.json");
});

afterEach(async () => {
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	resetUsbNetMarkers();
	await rm(root, { recursive: true, force: true });
});

describe.each(["0123456789ABCDEF", "shared-unit-432"])(
	"legacy credential ownership for serial %s",
	(serial) => {
		it.each([
			["same session", false],
			["after restart", true],
		] as const)(
			"leaves the survivor unconfigured after twin removal (restart: %s)",
			async (_label, restart) => {
				// Given a real legacy store and two distinct USB parents sharing its id.
				const twins = constructedTwins.map((device) => ({ ...device, serial }));
				const legacyId = mintLinkId(`usb-serial:413c:${serial}`);
				const saved = JSON.stringify({
					version: 1,
					devices: { [legacyId]: { ...credential, anchor: "usb-serial" } },
				});
				await writeFile(store, saved, { mode: 0o600 });
				await initModemCredentials(store);
				let hashes: string[] = [];
				const sharedSerials = {
					load: () => hashes,
					save: (next: string[]) => {
						hashes = next;
					},
				};
				await refreshUsbNetMarkers(
					twins.map((device) => device.ifname),
					{ ...constructedTwinDeps(twins), sharedSerials },
				);
				for (const twin of twins) {
					const device = resolveModemPhysicalIdentity(twin.ifname);
					expect(device.legacyLinkId).toBe(legacyId);
					expect(readModemCredential(device)).toBeUndefined();
				}

				// When only the sibling remains, optionally after losing runtime state.
				if (restart) {
					resetModemCredentialsForTest();
					resetPhysicalIdentityRegistry();
					resetUsbNetMarkers();
					await initModemCredentials(store);
				}
				const survivors = [{ ...second, serial }];
				await refreshUsbNetMarkers(
					survivors.map((device) => device.ifname),
					{ ...constructedTwinDeps(survivors), sharedSerials },
				);
				const survivor = resolveModemPhysicalIdentity(second.ifname);

				// Then neither lookup path may assign or consume the ambiguous login.
				expect(projectModemCredential(survivor)).toEqual({ configured: false });
				expect(readModemCredential(survivor)).toBeUndefined();
				expect(await Bun.file(store).text()).toBe(saved);
			},
		);
	},
);

it("retains a port-bound owner's credential after its twin leaves and restart", async () => {
	// Given a credential explicitly saved against one twin's resolved identity.
	await initModemCredentials(store);
	await refreshUsbNetMarkers(
		constructedTwins.map((device) => device.ifname),
		constructedTwinDeps(),
	);
	const owner = resolveModemPhysicalIdentity(first.ifname);
	expect(writeModemCredential(owner, credential)).toBe(true);

	// When its sibling leaves and all runtime caches are rebuilt.
	resetModemCredentialsForTest();
	resetPhysicalIdentityRegistry();
	resetUsbNetMarkers();
	await initModemCredentials(store);
	const survivors = constructedTwins.slice(0, 1);
	await refreshUsbNetMarkers(
		survivors.map((device) => device.ifname),
		constructedTwinDeps(survivors),
	);
	const presentOwner = resolveModemPhysicalIdentity(owner.ifname);

	// Then the durable identity still owns its login.
	expect(readModemCredential(presentOwner)).toEqual(credential);
	expect(projectModemCredential(presentOwner)).toEqual({ configured: true });
});

it("does not consume a credential whose exact owner is still present", async () => {
	// Given an exact-key owner and another device claiming its id as legacy.
	await initModemCredentials(store);
	const owner = resolvePhysicalDevice({
		ifname: "usb0",
		vid: "413c",
		serial: "unique-owner-432",
	});
	const other = resolvePhysicalDevice({
		ifname: "usb1",
		idPath: "platform-fc800000.usb-usb-0:1.4:1.0",
		legacyLinkId: owner.linkId,
	});
	setPresentPhysicalDevices([owner, other]);
	writeModemCredential(owner, credential);

	// When the other device looks for credentials.
	const inherited = readModemCredential(other);

	// Then no transfer or deletion of the present owner's credential is allowed.
	expect(inherited).toBeUndefined();
	expect(readModemCredential(owner)).toEqual(credential);
});
