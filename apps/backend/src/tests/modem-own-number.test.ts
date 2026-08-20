/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * THE SIM'S OWN NUMBER — READ, PROJECTED, AND REDACTED.
 *
 * The mmcli half is driven through the REAL parser, the REAL refresh merge and
 * the REAL wire builders against the bench board's own `-K` capture: a
 * hand-built `Modem` literal would sit downstream of the derivation this pins.
 * That capture already carries `modem.generic.own-numbers`, at mmcli's
 * ONE-BASED `value[1]` index, which is why the parse must not care about the
 * index number.
 *
 * The redaction half drives the REAL logger, because the value's whole contract
 * is that it may be DISPLAYED and may never be LOGGED — a property no unit test
 * of the key set alone can establish.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Writable } from "node:stream";
import winston from "winston";

import {
	isOwnNumberSensitiveKey,
	logRedact,
	REDACTED,
	redact,
} from "../helpers/logger.ts";
import { foldDbusModemViews } from "../modules/cellular/dbus-view-fold.ts";
import {
	type ModemInfo,
	mmcliParseSep,
	parseModemInfo,
} from "../modules/modems/mmcli.ts";
import {
	deriveOwnNumbers,
	mergeRefreshedModem,
} from "../modules/modems/modem-registration.ts";
import {
	buildModemsMessage,
	buildModemsWireMessage,
} from "../modules/modems/modem-status.ts";
import {
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import {
	getModemIds,
	type Modem,
	removeModem,
	setModem,
} from "../modules/modems/modems-state.ts";
import { setModemsState } from "../modules/modems/state/modems-state-cache.ts";
import { modemObjects } from "./support/mm-tree-fixture.ts";

/** The bench Quectel RM530N-GL's capture. Its own-number is the redacted form. */
const QUECTEL = "mmcli-modem-real-quectel-rm530n-gl.txt";
const QUECTEL_OWN_NUMBER = "+570000000000";

/** Every bench capture whose modem published no own-number at all. */
const NO_OWN_NUMBER = [
	"mmcli-modem-real-simcom-sim7600g-h.txt",
	"mmcli-modem-real-himi-u01.txt",
	"mmcli-modem-real-fibocom-fm350-gl.txt",
] as const;

/**
 * The board's REAL subscriber number, as `mmcli -m 3` reported it live. Used
 * only where the E.164 shape itself is under test; it is never written into a
 * shipped fixture.
 */
const BOARD_OWN_NUMBER = "+573115422359";

async function loadModemInfo(fixture: string): Promise<ModemInfo> {
	const path = new URL(`./fixtures/network/${fixture}`, import.meta.url);
	const parsed = parseModemInfo(mmcliParseSep(await Bun.file(path).text()));
	if (!parsed.ok) {
		throw new Error(`fixture ${fixture} did not parse: ${parsed.reason}`);
	}
	return parsed.value;
}

function baseModem(overrides: Partial<Modem> = {}): Modem {
	return {
		ifname: "wwan3",
		name: "Quectel RM530N-GL",
		sim_network: "Movistar",
		network_type: { supported: {}, active: null },
		status: {
			connection: "connected",
			network: "Movistar",
			network_type: "5G",
			signal: 81,
			roaming: false,
		},
		...overrides,
	};
}

function cleanupModems(): void {
	for (const id of getModemIds()) {
		removeModem(id);
	}
	setModemsState({});
}

describe("the mmcli read", () => {
	test("the bench capture's own-number survives mmcli's ONE-BASED array index", async () => {
		const modemInfo = await loadModemInfo(QUECTEL);

		expect(modemInfo["modem.generic.own-numbers"]).toEqual([
			QUECTEL_OWN_NUMBER,
		]);
		expect(deriveOwnNumbers(modemInfo)).toEqual([QUECTEL_OWN_NUMBER]);
	});

	test.each(NO_OWN_NUMBER)(
		"%s published none, so the key is absent — never an empty list",
		async (fixture) => {
			const modemInfo = await loadModemInfo(fixture);

			expect(Object.hasOwn(modemInfo, "modem.generic.own-numbers")).toBe(false);
			expect(deriveOwnNumbers(modemInfo)).toBeUndefined();
		},
	);

	test("a multi-number SIM keeps every number, in mmcli's own order", () => {
		const parsed = parseModemInfo(
			mmcliParseSep(
				[
					"modem.generic.model : RM530N-GL",
					"modem.generic.own-numbers.length : 2",
					`modem.generic.own-numbers.value[1] : ${BOARD_OWN_NUMBER}`,
					"modem.generic.own-numbers.value[2] : +573001112233",
				].join("\n"),
			),
		);

		expect(parsed.ok).toBe(true);
		expect(parsed.ok && parsed.value["modem.generic.own-numbers"]).toEqual([
			BOARD_OWN_NUMBER,
			"+573001112233",
		]);
	});

	test("a carrier that stated nothing renders as `--`, which the parser already drops", () => {
		const parsed = parseModemInfo(
			mmcliParseSep(
				[
					"modem.generic.model : RM530N-GL",
					"modem.generic.own-numbers.length : 0",
					"modem.generic.own-numbers.value[1] : --",
				].join("\n"),
			),
		);

		expect(parsed.ok).toBe(true);
		expect(parsed.ok && deriveOwnNumbers(parsed.value)).toBeUndefined();
	});

	test("a refresh REPLACES the number, so a swapped SIM cannot latch the previous one", async () => {
		const withNumber = mergeRefreshedModem(
			baseModem(),
			await loadModemInfo(QUECTEL),
		);
		expect(withNumber.own_numbers).toEqual([QUECTEL_OWN_NUMBER]);

		const afterSwap = mergeRefreshedModem(
			withNumber,
			await loadModemInfo("mmcli-modem-real-simcom-sim7600g-h.txt"),
		);

		expect(Object.hasOwn(afterSwap, "own_numbers")).toBe(false);
	});
});

describe("the wire projection", () => {
	afterEach(cleanupModems);

	test("an mmcli row carries the number as an additive-optional field", () => {
		const modem = baseModem({ own_numbers: [BOARD_OWN_NUMBER] });

		const projected = projectModemWire([fromMmcliModem(3, modem)], {
			hasGsmAutoconfig: false,
		});

		expect(projected.message["3"]?.own_numbers).toEqual([BOARD_OWN_NUMBER]);
	});

	test("a modem that published none omits the key entirely", () => {
		const projected = projectModemWire([fromMmcliModem(3, baseModem())], {
			hasGsmAutoconfig: false,
		});

		expect(Object.hasOwn(projected.message["3"] ?? {}, "own_numbers")).toBe(
			false,
		);
	});

	test("an EMPTY list is never published — the schema cannot express it", () => {
		const projected = projectModemWire(
			[fromMmcliModem(3, baseModem({ own_numbers: [] }))],
			{ hasGsmAutoconfig: false },
		);

		expect(Object.hasOwn(projected.message["3"] ?? {}, "own_numbers")).toBe(
			false,
		);
	});

	test("it is ADDITIVE: the rest of the entry stays byte-identical to the legacy builder", () => {
		const modem = baseModem({ own_numbers: [BOARD_OWN_NUMBER] });
		setModem(3, modem);

		const legacy = buildModemsMessage();
		const entry = {
			...(projectModemWire([fromMmcliModem(3, modem)], {
				hasGsmAutoconfig: false,
			}).message["3"] ?? {}),
		};

		expect(entry.own_numbers).toEqual([BOARD_OWN_NUMBER]);
		delete entry.own_numbers;
		expect(JSON.stringify(entry)).toBe(JSON.stringify(legacy["3"]));
	});

	test("it reaches the SHIPPED wire builder, not only the projector", () => {
		setModem(3, baseModem({ own_numbers: [BOARD_OWN_NUMBER] }));

		expect(buildModemsWireMessage()["3"]?.own_numbers).toEqual([
			BOARD_OWN_NUMBER,
		]);
		// The legacy oracle deliberately does NOT carry it — it is additive.
		expect(Object.hasOwn(buildModemsMessage()["3"] ?? {}, "own_numbers")).toBe(
			false,
		);
	});

	test("a D-Bus row folds `Modem.OwnNumbers` onto the same wire field", () => {
		const [view] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
				ownNumbers: [BOARD_OWN_NUMBER],
			}),
		);

		expect(view?.ownNumbers).toEqual([BOARD_OWN_NUMBER]);
		if (view === undefined) throw new Error("fold produced no view");

		const projected = projectModemWire([fromDbusView(view)], {
			hasGsmAutoconfig: false,
		});
		expect(projected.message["3"]?.own_numbers).toEqual([BOARD_OWN_NUMBER]);
	});

	test("a D-Bus modem publishing an EMPTY or blank list reads as not-reported", () => {
		const [empty] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/3",
				ifname: "wwan3",
				ownNumbers: [],
			}),
		);
		const [blank] = foldDbusModemViews(
			modemObjects({
				path: "/org/freedesktop/ModemManager1/Modem/4",
				ifname: "wwan4",
				ownNumbers: ["  ", ""],
			}),
		);

		expect(empty?.ownNumbers).toBeUndefined();
		expect(blank?.ownNumbers).toBeUndefined();
	});
});

describe("the number is DISPLAYED but never LOGGED", () => {
	test("every key spelling the stack can produce is scrubbed", () => {
		const out = logRedact({
			own_numbers: [BOARD_OWN_NUMBER],
			ownNumbers: [BOARD_OWN_NUMBER],
			OwnNumbers: [BOARD_OWN_NUMBER],
			own_number: BOARD_OWN_NUMBER,
			phoneNumber: BOARD_OWN_NUMBER,
			simNumber: BOARD_OWN_NUMBER,
			subscriberNumber: BOARD_OWN_NUMBER,
			"modem.generic.own-numbers": [BOARD_OWN_NUMBER],
		}) as Record<string, unknown>;

		for (const value of Object.values(out)) {
			expect(value).toBe(REDACTED);
		}
	});

	test("it is scrubbed at depth, inside a real modems wire payload", () => {
		const modem = baseModem({ own_numbers: [BOARD_OWN_NUMBER] });
		setModem(3, modem);
		const payload = buildModemsWireMessage();
		cleanupModems();

		const scrubbed = JSON.stringify(logRedact({ modems: payload }));

		expect(scrubbed).not.toContain(BOARD_OWN_NUMBER);
		expect(scrubbed).toContain(REDACTED);
		expect(scrubbed).toContain("wwan3");
	});

	test("a raw `-K` record pasted into a free-text line is scrubbed by VALUE", () => {
		const line = `modem.generic.own-numbers.value[1]: ${BOARD_OWN_NUMBER}`;

		expect(logRedact({ detail: line })).toEqual({ detail: REDACTED });
		expect(
			logRedact({ detail: "modem.generic.own-numbers.length: 1" }),
		).toEqual({ detail: REDACTED });
	});

	test("the REAL logger transport never emits the number", async () => {
		const lines: string[] = [];
		const capture = new winston.transports.Stream({
			stream: new Writable({
				write(chunk, _encoding, done) {
					lines.push(String(chunk));
					done();
				},
			}),
			format: winston.format.combine(redact(), winston.format.json()),
			level: "debug",
		});
		const probe = winston.createLogger({
			level: "debug",
			transports: [capture],
		});

		probe.warn("modem refresh", {
			ifname: "wwan3",
			own_numbers: [BOARD_OWN_NUMBER],
			slotNumber: 1,
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		probe.close();

		const emitted = lines.join("");
		expect(emitted).not.toContain(BOARD_OWN_NUMBER);
		expect(emitted).toContain(REDACTED);
		expect(emitted).toContain("wwan3");
		expect(emitted).toContain('"slotNumber":1');
	});

	test("the class does not over-redact ordinary number fields", () => {
		const out = logRedact({
			number: 3,
			numbers: [1, 2, 3],
			slotNumber: 1,
			serialNumber: "c6125db3",
			ownNumberSupported: true,
		}) as Record<string, unknown>;

		expect(out).toEqual({
			number: 3,
			numbers: [1, 2, 3],
			slotNumber: 1,
			serialNumber: "c6125db3",
			ownNumberSupported: true,
		});
		expect(isOwnNumberSensitiveKey("number")).toBe(false);
		expect(isOwnNumberSensitiveKey("ownNumberSupported")).toBe(false);
		expect(isOwnNumberSensitiveKey("own_numbers")).toBe(true);
	});
});
