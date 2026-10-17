import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { call } from "@orpc/server";
import { addonIntentRevision } from "../modules/addons/mutation.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import {
	installAddonProcedure,
	listAddonsProcedure,
	uninstallAddonProcedure,
} from "../rpc/procedures/addons.procedure.ts";
import {
	addonDescriptorIdentityFixture,
	identityDescriptor,
} from "./helpers/addon-descriptor-identity-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";
import { makeRpcContext } from "./helpers/bond-toggle-fixture.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof addonDescriptorIdentityFixture>;
beforeEach(() => {
	fixture = addonDescriptorIdentityFixture();
});
afterEach(() => fixture.reset());

test("default baked-directory scan skips and logs a misplaced slot exactly once", async () => {
	// Given two descriptors claiming b and one healthy b slot.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	await fixture.writeDescriptor("b", identityDescriptor("b"));
	fixture.bindDefaultScan();
	// When the production RPC runs its unchanged default directory scanner.
	const result = await call(listAddonsProcedure, undefined, {
		context: makeRpcContext(),
	});
	// Then the misplaced slot is invalid, never a second b authority.
	expect(result.addons.map((item) => item.descriptor.id)).toEqual(["b"]);
	expect(fixture.logs).toHaveLength(1);
	expect(fixture.logs[0]).toContain("a.json");
	expect(fixture.effects).toEqual([]);
});

for (const [action, procedure] of [
	["install", installAddonProcedure],
	["uninstall", uninstallAddonProcedure],
] as const) {
	test(`${action} cannot act as b when only a.json claims b`, async () => {
		// Given a misplaced descriptor and existing b intent/evidence.
		await fixture.writeDescriptor("a", identityDescriptor("b"));
		const bytes = await Bun.file(join(fixture.registry, "a.json")).text();
		setAddonState("b", {
			enabled: true,
			phase: "active",
			autoDisabled: false,
			userConfig: { preserved: "b" },
		});
		const revision = addonIntentRevision("b");
		fixture.bindDefaultScan();
		// When b is explicitly requested through the real mutation handler.
		const result = await call(
			procedure,
			{ id: "b" },
			{ context: makeRpcContext() },
		);
		// Then neither enable nor disable can borrow a's misfiled authority.
		expect(result).toEqual({ success: false, error: "addon_not_found" });
		expect(fixture.effects).toEqual([]);
		expect(getAddons().b).toEqual({
			enabled: true,
			phase: "active",
			autoDisabled: false,
			userConfig: { preserved: "b" },
		});
		expect(addonIntentRevision("b")).toBe(revision);
		expect(await Bun.file(join(fixture.registry, "a.json")).text()).toBe(bytes);
		expect(fixture.logs).toHaveLength(1);
	});
}

test("requesting invalid a cannot substitute the correctly bound b sibling downstream", async () => {
	// Given invalid a and valid b, both claiming b.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	await fixture.writeDescriptor("b", identityDescriptor("b"));
	fixture.bindDefaultScan();
	// When a is requested, the requested id remains the selection authority.
	const result = await call(
		installAddonProcedure,
		{ id: "a" },
		{ context: makeRpcContext() },
	);
	// Then discovery cannot upgrade b's identity into a's request.
	expect(result).toEqual({ success: false, error: "addon_not_found" });
	expect(fixture.effects).toEqual([]);
	expect(getAddons()).toEqual({});
});

test("correctly bound sibling still runs the real manager enable pipeline beside damage", async () => {
	// Given a permanently misplaced slot beside a healthy b.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	await fixture.writeDescriptor("b", identityDescriptor("b"));
	fixture.bindDefaultScan();
	// When the real installer selects b.json and delegates to the real manager.
	const result = await call(
		installAddonProcedure,
		{ id: "b" },
		{ context: makeRpcContext() },
	);
	// Then b retains its normal ordered preparation/activation contract.
	expect(result).toEqual({ success: true, phase: "enabled" });
	expect(fixture.effects).toEqual([
		"download:/data/tmp/b.raw.tmp",
		"verify",
		"stage:/var/cache/ceralive/addons/b.raw",
		"enable:b",
	]);
	expect(getAddons().b).toEqual({
		enabled: true,
		phase: "active",
		autoDisabled: false,
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
	});
	expect(fixture.logs).toHaveLength(1);
});
