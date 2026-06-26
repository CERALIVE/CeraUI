/*
 * S2 hardening — named, fail-loud nmcli result parsers.
 *
 * Happy-path AND malformed-input (output-drift) cases for every extracted
 * parser. The stderr+exitCode surfacing of the consuming call sites is covered
 * centrally by cli-parse.test.ts (describeCliError) — the run()/execFileP spawn
 * seam can't be reliably spied under Bun 1.3.14's ESM re-export binding.
 */

import { describe, expect, it } from "bun:test";

import { isParseError } from "../system/cli-parse.ts";
import {
	parseNmConnActivated,
	parseNmConnAddUuid,
	parseNmConnDeactivated,
	parseNmConnDeleted,
	parseNmHotspotUuid,
} from "./network-manager.ts";

describe("parseNmConnAddUuid", () => {
	it("extracts the UUID from a successful add", () => {
		const r = parseNmConnAddUuid(
			"Connection 'modem-0' (1c2d3e4f-aaaa-bbbb-cccc-1234567890ab) successfully added.\n",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe("1c2d3e4f-aaaa-bbbb-cccc-1234567890ab");
	});

	it("fails loud when the confirmation line is absent (drift)", () => {
		const r = parseNmConnAddUuid("Error: connection add failed: bad property");
		expect(isParseError(r)).toBe(true);
		if (!r.ok) expect(r.reason).toContain("successfully added");
	});
});

describe("parseNmHotspotUuid", () => {
	it("extracts the hotspot UUID on success", () => {
		const r = parseNmHotspotUuid(
			"Device 'wlan0' successfully activated with 'abc-123'.\n",
		);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.value).toBe("abc-123");
	});

	it("fails loud when no activation line is present (drift)", () => {
		const r = parseNmHotspotUuid(
			"Error: Failed to add/activate new connection",
		);
		expect(isParseError(r)).toBe(true);
	});
});

describe("nmcli boolean result parsers", () => {
	it("parseNmConnDeleted matches the deletion confirmation", () => {
		expect(
			parseNmConnDeleted("Connection 'x' (uuid) successfully deleted."),
		).toBe(true);
		expect(parseNmConnDeleted("Error: unknown connection")).toBe(false);
	});

	it("parseNmConnActivated matches the activation confirmation", () => {
		expect(
			parseNmConnActivated("Connection successfully activated (D-Bus ...)"),
		).toBe(true);
		expect(parseNmConnActivated("Error: timeout")).toBe(false);
	});

	it("parseNmConnDeactivated matches the deactivation confirmation", () => {
		expect(
			parseNmConnDeactivated("Connection 'x' successfully deactivated (...)"),
		).toBe(true);
		expect(parseNmConnDeactivated("Error: not active")).toBe(false);
	});
});
