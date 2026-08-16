import { describe, expect, test } from "bun:test";

import {
	mmcliParseSep,
	parseModemInfo,
	parseSimInfo,
} from "../modules/modems/mmcli.ts";

const MODEM_OUTPUT = `modem.dbus-path                                 : /org/freedesktop/ModemManager1/Modem/0
modem.generic.device-identifier                 : sid01230j0wasd9h2f34ionasdf
modem.generic.model                             : L850-GL
modem.generic.equipment-identifier              : 012345678901234
modem.generic.sim                               : /org/freedesktop/ModemManager1/SIM/0
modem.generic.state                             : connected
modem.generic.ports.length                      : 2
modem.generic.ports.value[1]                    : ttyACM0 (at)
modem.generic.ports.value[2]                    : wwan0 (net)
modem.generic.supported-modes.length            : 1
modem.generic.supported-modes.value[1]          : allowed: 3g, 4g; preferred: 4g
modem.generic.current-modes                     : allowed: 3g, 4g; preferred: 4g
modem.generic.access-technologies.length        : 1
modem.generic.access-technologies.value[1]      : lte
modem.generic.signal-quality.value              : 41
modem.generic.unlock-required                   : sim-pin2
modem.generic.unlock-retries.length             : 1
modem.generic.unlock-retries.value[1]           : sim-pin2 (3)
modem.3gpp.operator-name                        : Movistar
modem.3gpp.registration-state                   : home`;

const SIM_OUTPUT = `sim.dbus-path                                   : /org/freedesktop/ModemManager1/SIM/0
sim.properties.iccid                            : 8934071100012345678
sim.properties.operator-code                    : 21407
sim.properties.operator-name                    : Movistar`;

describe("parseModemInfo — the same shape the cast used to assert", () => {
	test("a real mmcli record yields every field the consumers read", () => {
		const parsed = parseModemInfo(mmcliParseSep(MODEM_OUTPUT));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["modem.generic.device-identifier"]).toBe(
			"sid01230j0wasd9h2f34ionasdf",
		);
		expect(parsed.value["modem.generic.sim"]).toBe(
			"/org/freedesktop/ModemManager1/SIM/0",
		);
		expect(parsed.value["modem.generic.ports"]).toEqual([
			"ttyACM0 (at)",
			"wwan0 (net)",
		]);
		expect(parsed.value["modem.generic.access-technologies"]).toEqual(["lte"]);
		expect(parsed.value["modem.generic.current-modes"]).toBe(
			"allowed: 3g, 4g; preferred: 4g",
		);
		expect(parsed.value["modem.3gpp.operator-name"]).toBe("Movistar");
		expect(parsed.value["modem.3gpp.registration-state"]).toBe("home");
	});

	test("the signal quality is a real number, not the raw mmcli text", () => {
		const parsed = parseModemInfo(mmcliParseSep(MODEM_OUTPUT));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["modem.generic.signal-quality.value"]).toBe(41);
	});

	test("a non-numeric signal quality degrades the reading, not the modem", () => {
		const parsed = parseModemInfo(
			mmcliParseSep(
				`modem.generic.device-identifier : abc\nmodem.generic.signal-quality.value : n/a`,
			),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(
			Number.isNaN(parsed.value["modem.generic.signal-quality.value"]),
		).toBe(true);
		expect(parsed.value["modem.generic.device-identifier"]).toBe("abc");
	});

	test("the raw unlock fields survive for the SIM-lock derivation", () => {
		const parsed = parseModemInfo(mmcliParseSep(MODEM_OUTPUT));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		const raw = parsed.value as unknown as Record<string, unknown>;
		expect(raw["modem.generic.unlock-required"]).toBe("sim-pin2");
		expect(raw["modem.generic.unlock-retries"]).toEqual(["sim-pin2 (3)"]);
	});

	test("a SIM-less modem is still accepted — mmcli prints `--` and the key drops", () => {
		const parsed = parseModemInfo(
			mmcliParseSep(
				`modem.generic.device-identifier : abc\nmodem.generic.sim : --\nmodem.generic.state : disabled`,
			),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["modem.generic.sim"]).toBeFalsy();
		expect(parsed.value["modem.generic.ports"]).toEqual([]);
		expect(parsed.value["modem.3gpp.operator-name"]).toBeUndefined();
	});

	test("output that is not modem info is a typed rejection, never a crash", () => {
		const parsed = parseModemInfo(mmcliParseSep("error: could not find modem"));

		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.kind).toBe("parse-error");
		expect(parsed.parser).toBe("parseModemInfo");
	});
});

describe("parseSimInfo", () => {
	test("a real mmcli SIM record yields the fields the consumers read", () => {
		const parsed = parseSimInfo(mmcliParseSep(SIM_OUTPUT));

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["sim.properties.iccid"]).toBe("8934071100012345678");
		expect(parsed.value["sim.properties.operator-code"]).toBe("21407");
		expect(parsed.value["sim.properties.operator-name"]).toBe("Movistar");
	});

	test("a locked SIM withholding its ICCID is still accepted", () => {
		const parsed = parseSimInfo(
			mmcliParseSep(
				`sim.dbus-path : /org/freedesktop/ModemManager1/SIM/0\nsim.properties.iccid : --`,
			),
		);

		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		expect(parsed.value["sim.properties.iccid"]).toBeFalsy();
		expect(parsed.value["sim.properties.operator-name"]).toBeUndefined();
	});

	test("output that is not SIM info is a typed rejection, never a crash", () => {
		const parsed = parseSimInfo(mmcliParseSep("error: could not find sim"));

		expect(parsed.ok).toBe(false);
		if (parsed.ok) return;
		expect(parsed.parser).toBe("parseSimInfo");
	});
});
