/**
 * Unit tests for os-toggle-predicates.ts
 *
 * Drives the pure hotspot / SSH confirm predicates directly — no runes, no
 * Svelte runtime. These are the exact decisions the HotspotDialog and SshDialog
 * confirm `$effect`s make, so the dialogs stay thin shells over a tested core.
 */

import { describe, expect, it } from "vitest";

import {
	hotspotIsActive,
	hotspotToggleConfirmed,
	sshIsActive,
	sshToggleConfirmed,
} from "./os-toggle-predicates";

describe("hotspotIsActive", () => {
	it("is active when the interface carries a live hotspot config", () => {
		expect(hotspotIsActive({ hotspot: { name: "Cera", password: "x" } })).toBe(
			true,
		);
	});

	it("is inactive when the hotspot field is absent", () => {
		expect(hotspotIsActive({})).toBe(false);
	});

	it("is inactive for a null/undefined interface", () => {
		expect(hotspotIsActive(null)).toBe(false);
		expect(hotspotIsActive(undefined)).toBe(false);
	});

	it("treats a falsy hotspot value as inactive", () => {
		expect(hotspotIsActive({ hotspot: undefined })).toBe(false);
		expect(hotspotIsActive({ hotspot: null })).toBe(false);
	});
});

describe("hotspotToggleConfirmed", () => {
	it("confirms a hotspot-start once the interface is active", () => {
		expect(hotspotToggleConfirmed("hotspot", true)).toBe(true);
	});

	it("does NOT confirm a hotspot-start while still inactive", () => {
		expect(hotspotToggleConfirmed("hotspot", false)).toBe(false);
	});

	it("confirms a hotspot-stop once the interface is inactive", () => {
		expect(hotspotToggleConfirmed("station", false)).toBe(true);
	});

	it("does NOT confirm a hotspot-stop while still active", () => {
		expect(hotspotToggleConfirmed("station", true)).toBe(false);
	});

	it("never confirms when no op is in flight (null target)", () => {
		expect(hotspotToggleConfirmed(null, true)).toBe(false);
		expect(hotspotToggleConfirmed(null, false)).toBe(false);
	});
});

describe("sshIsActive", () => {
	it("reflects ssh.active when present", () => {
		expect(sshIsActive({ active: true })).toBe(true);
		expect(sshIsActive({ active: false })).toBe(false);
	});

	it("is inactive when active is absent", () => {
		expect(sshIsActive({})).toBe(false);
	});

	it("is inactive for a null/undefined status", () => {
		expect(sshIsActive(null)).toBe(false);
		expect(sshIsActive(undefined)).toBe(false);
	});
});

describe("sshToggleConfirmed", () => {
	it("confirms a start once ssh.active matches true", () => {
		expect(sshToggleConfirmed(true, true)).toBe(true);
	});

	it("confirms a stop once ssh.active matches false", () => {
		expect(sshToggleConfirmed(false, false)).toBe(true);
	});

	it("does NOT confirm while the live state still differs from the target", () => {
		expect(sshToggleConfirmed(false, true)).toBe(false);
		expect(sshToggleConfirmed(true, false)).toBe(false);
	});

	it("never confirms when no op is in flight (null target)", () => {
		expect(sshToggleConfirmed(true, null)).toBe(false);
		expect(sshToggleConfirmed(false, null)).toBe(false);
	});
});
