/*
 * S2 hardening — named `systemctl is-active ssh` parser.
 *
 * Happy path (the literal "active" line) AND malformed/other-state inputs
 * (inactive / failed / unknown / empty) all resolve to a strict boolean.
 */

import { describe, expect, it } from "bun:test";

import { parseSystemctlIsActive } from "./ssh.ts";

describe("parseSystemctlIsActive", () => {
	it("returns true only for the literal active line", () => {
		expect(parseSystemctlIsActive("active\n")).toBe(true);
		expect(parseSystemctlIsActive("  active  ")).toBe(true);
	});

	it("returns false for every other systemctl state", () => {
		expect(parseSystemctlIsActive("inactive\n")).toBe(false);
		expect(parseSystemctlIsActive("failed\n")).toBe(false);
		expect(parseSystemctlIsActive("unknown\n")).toBe(false);
		expect(parseSystemctlIsActive("activating\n")).toBe(false);
	});

	it("returns false on empty / drifted output", () => {
		expect(parseSystemctlIsActive("")).toBe(false);
		expect(parseSystemctlIsActive("Unit ssh.service could not be found.")).toBe(
			false,
		);
	});
});
