import { describe, expect, it } from "bun:test";

import {
	ROUTER_CREDENTIAL_DEFAULTS,
	resolveRouterCredential,
} from "../modules/network/router-credentials.ts";

describe("vendor credential defaults", () => {
	it("offers no implicit credential for HiLink or an unknown profile", () => {
		expect(resolveRouterCredential("huawei-hilink")).toBeUndefined();
		expect(resolveRouterCredential("default")).toBeUndefined();
	});

	it("uses the public generic RNDIS default", () => {
		expect(resolveRouterCredential("generic-rndis")).toEqual({
			username: "admin",
			password: "admin",
		});
		expect(ROUTER_CREDENTIAL_DEFAULTS["huawei-hilink"]).toBeNull();
	});

	it.each(["huawei-hilink", "generic-rndis", "default"] as const)(
		"prefers an operator credential for %s",
		(profile) => {
			const override = {
				username: "fixture-operator",
				password: "fixture-only-override",
			};
			expect(resolveRouterCredential(profile, override)).toBe(override);
		},
	);
});
