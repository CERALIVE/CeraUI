import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
	FEDERATION_ABI_VERSION,
	type FederationHostAdapter,
	type FederationMountOptions,
	requireAppliedConfig,
} from "./host-contract";

describe("requireAppliedConfig", () => {
	it("accepts an applied host command", () => {
		expect(() =>
			requireAppliedConfig({ success: true, applied: {} }),
		).not.toThrow();
	});

	it("surfaces the host error from a refused command", () => {
		expect(() =>
			requireAppliedConfig({ success: false, error: "device_offline" }),
		).toThrow("device_offline");
	});
});

/**
 * The ABI is a CROSS-REPO contract: `ceralive-platform` compiles against this
 * interface and loads bundles it did not build, so a field promoted to required
 * breaks every host older than the release that promoted it — silently, at
 * runtime, in someone else's repo. Nothing else in this workspace can catch
 * that, so the shape is pinned mechanically here rather than by convention.
 *
 * The split is the whole point: the REQUIRED set is frozen, and growth is only
 * ever permitted in the OPTIONAL set.
 */
const SOURCE = readFileSync(
	new URL("./host-contract.ts", import.meta.url),
	"utf8",
);

function mountOptionKeys(): { required: string[]; optional: string[] } {
	const body = /interface FederationMountOptions \{([\s\S]*?)\n\}/.exec(
		SOURCE,
	)?.[1];
	if (body === undefined) throw new Error("FederationMountOptions not found");
	const required: string[] = [];
	const optional: string[] = [];
	// Declarations only — a `?:` inside a doc comment must not be counted, so the
	// match is anchored to the `readonly` member syntax at line start.
	for (const match of body.matchAll(/^\treadonly (\w+)(\??):/gm)) {
		(match[2] === "?" ? optional : required).push(match[1] as string);
	}
	return { required: required.sort(), optional: optional.sort() };
}

describe("FederationMountOptions — additive-only ABI", () => {
	it("pins the ABI version every host compiled against", () => {
		expect(FEDERATION_ABI_VERSION).toBe(1);
	});

	it("keeps the REQUIRED option set frozen at `host`", () => {
		// Growing this list is an ABI BREAK, not an addition: an older host that
		// does not pass the new field stops satisfying the contract.
		expect(mountOptionKeys().required).toEqual(["host"]);
	});

	it("keeps every previously-shipped option OPTIONAL", () => {
		const { optional } = mountOptionKeys();
		for (const key of ["config", "locale"]) expect(optional).toContain(key);
	});

	it("declares every option added since as OPTIONAL too", () => {
		expect(mountOptionKeys().optional).toContain("capabilities");
	});

	it("NON-VACUITY: the parser reads real declarations, not comment prose", () => {
		const keys = mountOptionKeys();
		expect([...keys.required, ...keys.optional].length).toBeGreaterThan(2);
		expect(keys.required).not.toContain("capabilities");
	});

	it("a legacy host passing only `host` still satisfies the contract", () => {
		// Compile-time proof: this file fails `svelte-check` if any of the three
		// call shapes below stops type-checking.
		const adapter = {
			setConfig: async () => ({ success: true, applied: {} }),
			validateRelay: async () => ({ ok: true, stages: [] }),
		} as unknown as FederationHostAdapter;

		const legacy: FederationMountOptions = { host: adapter };
		const preTodo20: FederationMountOptions = {
			host: adapter,
			config: undefined,
			locale: "en",
		};
		const current: FederationMountOptions = {
			host: adapter,
			locale: "en",
			capabilities: { audio_backends: { supported: ["alsa"], active: "alsa" } },
		};

		expect(legacy.host).toBe(adapter);
		expect(preTodo20.locale).toBe("en");
		expect(current.capabilities?.audio_backends?.active).toBe("alsa");
	});
});
