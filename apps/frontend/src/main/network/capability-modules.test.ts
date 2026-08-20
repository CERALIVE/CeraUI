import {
	CAPABILITY_MODULES,
	type CapabilityModuleClaims,
	type SupportClaimState,
} from "@ceraui/rpc/schemas";
import { describe, expect, it } from "vitest";

import {
	buildCapabilityModuleViews,
	surfacedCapabilityModules,
} from "./capability-modules";

function claims(
	overrides: Partial<Record<string, SupportClaimState>> = {},
): CapabilityModuleClaims {
	return Object.fromEntries(
		CAPABILITY_MODULES.map((module) => [
			module,
			overrides[module] ?? "implemented",
		]),
	) as CapabilityModuleClaims;
}

describe("capability-module rendering", () => {
	it("renders every module, never a filtered subset", () => {
		const views = buildCapabilityModuleViews(claims());
		expect(views.map((view) => view.module)).toEqual([...CAPABILITY_MODULES]);
	});

	it("surfaces nothing while the gates are off", () => {
		expect(surfacedCapabilityModules(claims())).toEqual([]);
	});

	it("surfaces a module only when it is enabled AND the modem is capable", () => {
		expect(
			surfacedCapabilityModules(
				claims({ "band-lock": "capable", gps: "enabled" }),
			),
		).toEqual(["band-lock"]);
	});

	it("surfaces a certified module too — certification governs claims, not use", () => {
		expect(surfacedCapabilityModules(claims({ esim: "certified" }))).toEqual([
			"esim",
		]);
	});

	it("renders an incapable modem's module as unavailable, not as a missing row", () => {
		const views = buildCapabilityModuleViews(claims({ ussd: "unavailable" }));
		const ussd = views.find((view) => view.module === "ussd");
		expect(ussd).toEqual({
			module: "ussd",
			state: "unavailable",
			surfaced: false,
		});
	});

	it("fails CLOSED for a backend that publishes no matrix at all", () => {
		const views = buildCapabilityModuleViews(undefined);
		expect(views).toHaveLength(CAPABILITY_MODULES.length);
		for (const view of views) {
			expect(view.state).toBe("unavailable");
			expect(view.surfaced).toBe(false);
		}
	});
});
