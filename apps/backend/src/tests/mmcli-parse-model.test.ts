import { describe, expect, test } from "bun:test";

import { parseMmcliModel } from "../modules/modems/mmcli.ts";

import em7455 from "./fixtures/mmcli/em7455.json" with { type: "json" };
import rm500qGl from "./fixtures/mmcli/rm500q-gl.json" with { type: "json" };
import rm520nGl from "./fixtures/mmcli/rm520n-gl.json" with { type: "json" };

describe("parseMmcliModel — modem families", () => {
	test("RM520N-GL / Quectel (object input)", () => {
		expect(parseMmcliModel(rm520nGl)).toEqual({
			model: "RM520N-GL",
			manufacturer: "Quectel",
		});
	});

	test("RM520N-GL / Quectel (string input)", () => {
		expect(parseMmcliModel(JSON.stringify(rm520nGl))).toEqual({
			model: "RM520N-GL",
			manufacturer: "Quectel",
		});
	});

	test("EM7455 / Sierra Wireless (object input, raw unnormalized strings)", () => {
		expect(parseMmcliModel(em7455)).toEqual({
			model: "Sierra Wireless EM7455 Qualcomm Snapdragon X7 LTE-A",
			manufacturer: "Sierra Wireless, Incorporated",
		});
	});

	test("EM7455 / Sierra Wireless (string input)", () => {
		expect(parseMmcliModel(JSON.stringify(em7455))).toEqual({
			model: "Sierra Wireless EM7455 Qualcomm Snapdragon X7 LTE-A",
			manufacturer: "Sierra Wireless, Incorporated",
		});
	});

	test("RM500Q-GL / Quectel (object input)", () => {
		expect(parseMmcliModel(rm500qGl)).toEqual({
			model: "RM500Q-GL",
			manufacturer: "Quectel",
		});
	});

	test("RM500Q-GL / Quectel (string input)", () => {
		expect(parseMmcliModel(JSON.stringify(rm500qGl))).toEqual({
			model: "RM500Q-GL",
			manufacturer: "Quectel",
		});
	});
});

describe("parseMmcliModel — version tolerance", () => {
	test("falls back to modem.hardware.{model,manufacturer} when generic block lacks them", () => {
		expect(
			parseMmcliModel({
				modem: {
					generic: { state: "connected" },
					hardware: { model: "RM520N-GL", manufacturer: "Quectel" },
				},
			}),
		).toEqual({ model: "RM520N-GL", manufacturer: "Quectel" });
	});

	test("prefers modem.generic over modem.hardware when both present", () => {
		expect(
			parseMmcliModel({
				modem: {
					generic: { model: "RM500Q-GL", manufacturer: "Quectel" },
					hardware: { model: "WRONG", manufacturer: "WRONG" },
				},
			}),
		).toEqual({ model: "RM500Q-GL", manufacturer: "Quectel" });
	});
});

describe("parseMmcliModel — degraded inputs (never throws)", () => {
	test('"no modem found" string → {}', () => {
		expect(parseMmcliModel("no modem found")).toEqual({});
	});

	test("empty string → {}", () => {
		expect(parseMmcliModel("")).toEqual({});
	});

	test("whitespace-only string → {}", () => {
		expect(parseMmcliModel("   \n  ")).toEqual({});
	});

	test("malformed / partial JSON string → {}", () => {
		expect(parseMmcliModel('{"modem": {"generic": {"model":')).toEqual({});
	});

	test("JSON missing the modem block → {}", () => {
		expect(parseMmcliModel({ foo: "bar" })).toEqual({});
	});

	test("JSON missing generic and hardware blocks → {}", () => {
		expect(parseMmcliModel({ modem: { "3gpp": {} } })).toEqual({});
	});

	test("partial: model present, manufacturer absent → { model } only", () => {
		expect(
			parseMmcliModel({ modem: { generic: { model: "RM520N-GL" } } }),
		).toEqual({ model: "RM520N-GL" });
	});

	test("partial: manufacturer present, model absent → { manufacturer } only", () => {
		expect(
			parseMmcliModel({ modem: { generic: { manufacturer: "Quectel" } } }),
		).toEqual({ manufacturer: "Quectel" });
	});

	test('mmcli placeholder "--" values are treated as absent', () => {
		expect(
			parseMmcliModel({
				modem: { generic: { model: "--", manufacturer: "--" } },
			}),
		).toEqual({});
	});

	test("null input → {}", () => {
		expect(parseMmcliModel(null as unknown as string)).toEqual({});
	});

	test("non-object/non-string input → {}", () => {
		expect(parseMmcliModel(42 as unknown as string)).toEqual({});
	});

	test("non-string model field → ignored", () => {
		expect(
			parseMmcliModel({ modem: { generic: { model: 123, manufacturer: [] } } }),
		).toEqual({});
	});
});
