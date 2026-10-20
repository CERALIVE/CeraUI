import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { readAddonDescriptor } from "../modules/addons/descriptor-authority.ts";
import {
	addonIntentRevision,
	hasAddonMutation,
	invalidateAddonIntent,
	withAddonMutation,
} from "../modules/addons/mutation.ts";
import { runAddonReconciler } from "../modules/addons/reconciler.ts";
import { getAddons, setAddonState } from "../modules/config.ts";
import {
	addonDescriptorIdentityFixture,
	identityDescriptor,
} from "./helpers/addon-descriptor-identity-fixture.ts";
import { useSessionOwnerForFile } from "./helpers/bind-session-owner.ts";

useSessionOwnerForFile();
let fixture: ReturnType<typeof addonDescriptorIdentityFixture>;
beforeEach(() => {
	fixture = addonDescriptorIdentityFixture();
});
afterEach(() => fixture.reset());

test("a misplaced descriptor is invalid at the strict read boundary, not absence", async () => {
	// Given a schema-valid b record stored in a's slot.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	// When the production authority reader reads the actual file.
	await expect(
		readAddonDescriptor(join(fixture.registry, "a.json")),
	).rejects.toMatchObject({ slot: "a.json", descriptorId: "b" });
	// Then invalid evidence remains intact, unlike a missing slot.
	expect(await Bun.file(join(fixture.registry, "a.json")).json()).toEqual(
		identityDescriptor("b"),
	);
});

test("reconciliation refuses a.json naming b without touching b's live owner or intent", async () => {
	// Given misfiled authority and an independently owned b artifact.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	const bytes = await Bun.file(join(fixture.registry, "a.json")).text();
	await Bun.write(join(fixture.root, "b.raw"), "owned-b-payload");
	setAddonState("a", {
		enabled: true,
		phase: "pending",
		autoDisabled: false,
		userConfig: { intent: "a" },
	});
	setAddonState("b", {
		enabled: false,
		phase: "idle",
		autoDisabled: false,
		userConfig: { intent: "b" },
	});
	const revision = addonIntentRevision("a");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const owner = withAddonMutation("b", async () => {
		entered.resolve();
		await release.promise;
	});
	await entered.promise;
	try {
		// When a reconciles while b's mutation lifetime remains active.
		await runAddonReconciler(fixture.deps);
		// Then refusal affects only a's status, not either intent or b's bytes.
		expect(getAddons().a).toEqual({
			enabled: true,
			phase: "error",
			autoDisabled: false,
			userConfig: { intent: "a" },
			lastError: "addon_descriptor_unavailable",
		});
		expect(getAddons().b).toEqual({
			enabled: false,
			phase: "idle",
			autoDisabled: false,
			userConfig: { intent: "b" },
		});
		expect(fixture.effects).toEqual([]);
		expect(hasAddonMutation("a")).toBe(false);
		expect(hasAddonMutation("b")).toBe(true);
		expect(addonIntentRevision("a")).toBe(revision);
		expect(await Bun.file(join(fixture.root, "b.raw")).text()).toBe(
			"owned-b-payload",
		);
		expect(await Bun.file(join(fixture.registry, "a.json")).text()).toBe(bytes);
		expect(fixture.logs).toHaveLength(1);
		expect(fixture.logs[0]).toContain("a.json");
	} finally {
		release.resolve();
		await owner;
	}
});

test("permanent mismatch terminates each pass and leaves a correctly bound sibling serviceable", async () => {
	// Given two slots claiming b, only b.json is valid.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	await fixture.writeDescriptor("b", identityDescriptor("b"));
	for (const id of ["a", "b"])
		setAddonState(id, { enabled: true, phase: "pending", autoDisabled: false });
	// When repeated boot/SIGUSR1 passes read the same permanent mismatch.
	await runAddonReconciler(fixture.deps);
	await runAddonReconciler(fixture.deps);
	// Then each pass finishes; b materialises once, a never does.
	expect(fixture.effects).toEqual(["fetch:b", "publish:b", "refresh"]);
	expect(fixture.logs).toHaveLength(2);
	expect(getAddons().a).toEqual({
		enabled: true,
		phase: "error",
		autoDisabled: false,
		lastError: "addon_descriptor_unavailable",
	});
	expect(getAddons().b).toEqual({
		enabled: true,
		phase: "active",
		autoDisabled: false,
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
	});
	expect(await Bun.file(join(fixture.root, "a.raw")).exists()).toBe(false);
	expect(await Bun.file(join(fixture.root, "b.raw")).text()).toBe("payload");
});

test("a new reconciliation lifetime rereads invalid authority and succeeds after an explicit repair", async () => {
	// Given retained intent from an earlier failed lifetime.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	setAddonState("a", {
		enabled: true,
		phase: "error",
		autoDisabled: false,
		lastError: "addon_descriptor_unavailable",
	});
	// When an owner repairs the same slot before a fresh pass (not automatic repair).
	await fixture.writeDescriptor("a", identityDescriptor("a"));
	await runAddonReconciler({ ...fixture.deps });
	// Then the old refusal is not cached as a global admission latch.
	expect(fixture.effects).toEqual(["fetch:a", "publish:a", "refresh"]);
	expect(getAddons().a).toEqual({
		enabled: true,
		phase: "active",
		autoDisabled: false,
		versionMaterialized: "1.2.3",
		osVersionMaterialized: "13",
	});
});

test("a descriptor read completing after concurrent disable cannot rewrite that intent", async () => {
	// Given a real mismatch whose read awaits while the operator changes a.
	await fixture.writeDescriptor("a", identityDescriptor("b"));
	setAddonState("a", { enabled: true, phase: "pending", autoDisabled: false });
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const pass = runAddonReconciler({
		...fixture.deps,
		readDescriptor: async (id) => {
			entered.resolve();
			await release.promise;
			return fixture.deps.readDescriptor(id);
		},
	});
	await entered.promise;
	// When the same-ID lock commits newer disabled intent before the read returns.
	await withAddonMutation("a", async () => {
		invalidateAddonIntent("a");
		setAddonState("a", { enabled: false, phase: "idle", autoDisabled: false });
	});
	release.resolve();
	await pass;
	// Then a stale invalid read grants no publication or cross-ID effect.
	expect(getAddons().a).toEqual({
		enabled: false,
		phase: "idle",
		autoDisabled: false,
	});
	expect(fixture.effects).toEqual([]);
	expect(fixture.logs).toHaveLength(1);
	expect(fixture.logs[0]).toContain("a.json");
});
