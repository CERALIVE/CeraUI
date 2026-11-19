import { expect, spyOn, test } from "bun:test";
import { defaultAdapterModeDeps } from "../modules/wifi/wifi-adapter-mode-transition.ts";
import * as capabilities from "../modules/wifi/wifi-capabilities.ts";
import { defaultHotspotDeps } from "../modules/wifi/wifi-hotspot-activation.ts";
import {
	defaultHotspotConfigDeps,
	reconfigureHotspotForRegdomain,
} from "../modules/wifi/wifi-hotspot-config.ts";
import { radioIdentityReaders } from "../modules/wifi/wifi-radio-identity.ts";
import { fixture, request } from "./helpers/wifi-entry-fixture.ts";
import { mockQualifiedHybridActivation } from "./helpers/wifi-hotspot-test-setup.ts";
import { qualifiedHybridEvidence } from "./helpers/wifi-hybrid-qualification.ts";

test("mode admission refuses before saving intent when the radio changes during the channel read", async () => {
	const state = await fixture();
	mockQualifiedHybridActivation();
	spyOn(capabilities, "getWifiCapabilitiesForInterface").mockReturnValue({
		phy: "phy1",
		generation: "wifi6",
		bands: ["2.4", "5"],
		maxWidthMhz: { "2.4": 40, "5": 80 },
		apModes: ["2.4", "5"],
		staApCombo: { supported: true, sameChannelOnly: true },
		wpa3Sae: "unknown",
		regulatory: { country: "ES", is6GhzLegal: false, self_managed: false },
	});
	spyOn(defaultAdapterModeDeps, "readHybridChannel").mockImplementation(
		async (ifname) => {
			await state.rotate();
			return qualifiedHybridEvidence.readHybridChannel(ifname);
		},
	);
	const down = spyOn(defaultAdapterModeDeps, "stopHotspot").mockResolvedValue({
		success: false,
		error: "deactivation-failed",
	});
	try {
		expect(await request("hybrid", state.context, state.before)).toEqual({
			success: false,
			error: "radio-changed",
		});
		expect(state.effects).not.toContain("mode-write");
		expect(down).not.toHaveBeenCalled();
	} finally {
		await state.restore();
	}
});

test("regulatory reconfigure does not reactivate or commit credentials after the radio changes during the write", async () => {
	const state = await fixture();
	const write = spyOn(
		defaultHotspotConfigDeps,
		"nmConnSetFields",
	).mockImplementation(async () => {
		await state.rotate();
		return true;
	});
	const up = spyOn(defaultHotspotConfigDeps, "nmConnect").mockResolvedValue(
		false,
	);
	try {
		expect(
			await reconfigureHotspotForRegdomain(
				"dc:a6:32:aa:bb:c0",
				state.row,
				"auto",
			),
		).toBe(false);
		expect(up).not.toHaveBeenCalled();
		expect(write).toHaveBeenCalledTimes(1);
		expect(state.effects).not.toContain("store-write");
	} finally {
		await state.restore();
	}
});

test("Prepare does not repair or return credentials after a change during profile lookup", async () => {
	const state = await fixture();
	delete state.row.hotspot.password;
	spyOn(defaultHotspotDeps, "findHotspotConn").mockImplementation(async () => {
		spyOn(radioIdentityReaders, "readText").mockImplementation(async (path) =>
			path.endsWith("/ifindex")
				? "20"
				: path.endsWith("/index")
					? "1"
					: "dc:a6:32:aa:bb:c0",
		);
		return undefined;
	});
	try {
		expect(await request("prepare-load", state.context, state.before)).toEqual({
			success: false,
			error: "radio-changed",
		});
		expect(state.effects).toEqual(["store-read"]);
		expect(state.row.hotspot.password).toBeUndefined();
	} finally {
		await state.restore();
	}
});
