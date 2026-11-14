import { describe, expect, test } from "bun:test";

import type { ModemInfo } from "../modules/modems/mmcli.ts";
import { mergeRefreshedModem } from "../modules/modems/modem-registration.ts";
import {
	type DbusModemView,
	fromDbusView,
	fromMmcliModem,
} from "../modules/modems/modem-wire-adapters.ts";
import { projectModemWire } from "../modules/modems/modem-wire-projection.ts";
import type { Modem } from "../modules/modems/modems-state.ts";

// The measured 05c6:9091 QMI shape, with synthetic device/SIM identities.
const MODEM_INFO: ModemInfo = {
	"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/99",
	"modem.generic.state": "registered",
	"modem.generic.ports": ["cdc-wdm99 (qmi)", "wwan99 (net)"],
	"modem.generic.model": "0",
	"modem.generic.manufacturer": "1",
	"modem.generic.revision": "HIMI_U01_MODEM_V2.0  1  [May 13 2022 13:00:00]",
	"modem.generic.current-modes": "allowed: 4g; preferred: none",
	"modem.generic.supported-modes": ["allowed: 4g; preferred: none"],
	"modem.generic.equipment-identifier": "000000000000099",
	"modem.generic.device-identifier": "fixture-device-99",
	"modem.generic.access-technologies": ["lte"],
	"modem.generic.signal-quality.value": 76,
	"modem.3gpp.registration-state": "home",
	"modem.3gpp.packet-service-state": "attached",
};

const MODEM: Modem = {
	ifname: "wwan99",
	name: "Fixture stick",
	model: "0",
	sim_network: "Fixture carrier",
	network_type: {
		supported: { "4g": { allowed: "4g", preferred: "none" } },
		active: "4g",
	},
};

const DBUS_VIEW: DbusModemView = {
	runtimeId: 99,
	ifname: "wwan99",
	mmState: "registered",
	model: "0",
	manufacturer: "1",
	equipmentId: "000000000000099",
	registration: { status: "home", activeRats: new Set(["lte"]) },
	packetServiceState: "attached",
	signal: 76,
	supportedNetworkTypes: ["4g"],
	activeNetworkType: "4g",
	usbMode: "qmi",
};

describe("HiMI UFI router warning (#573)", () => {
	test.each([
		["0", "HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]"],
		["0", MODEM_INFO["modem.generic.revision"]],
		["HIMI_U01_MODEM_V2.0", undefined],
	])("recognizes model %s and firmware %s", (model, firmwareRevision) => {
		const source = fromDbusView({
			...DBUS_VIEW,
			model,
			...(firmwareRevision !== undefined ? { firmwareRevision } : {}),
		});

		expect(source.additive?.availability_reason).toBe("himi_ufi_router");
	});

	// A rejected host data call leaves MM registered/home/attached in the
	// evidence. Do not wait for MM's unrelated fatal `failed` state.
	test.each(["registered", "failed"])(
		"surfaces the specific warning after a data-call failure with MM %s",
		(state) => {
			const refreshed = mergeRefreshedModem(MODEM, {
				...MODEM_INFO,
				"modem.generic.state": state,
			});
			const result = projectModemWire([fromMmcliModem(99, refreshed)], {
				hasGsmAutoconfig: false,
			});

			expect(result.message["99"]?.availability_reason).toBe("himi_ufi_router");
			expect(result.message["99"]?.status?.connection).toBe(state);
		},
	);

	test.each([
		["M901", "M901_01.00"],
		["0", undefined],
		["UFI", undefined],
		["Android", undefined],
	])(
		"does not flag a regular 05c6:9091 QMI modem or ambiguous identity %s / %s",
		(model, firmwareRevision) => {
			const { "modem.generic.revision": _revision, ...withoutRevision } =
				MODEM_INFO;
			const info: ModemInfo = {
				...withoutRevision,
				"modem.generic.model": model,
				...(firmwareRevision !== undefined
					? { "modem.generic.revision": firmwareRevision }
					: {}),
			};

			const mmcli = fromMmcliModem(99, mergeRefreshedModem(MODEM, info));
			const dbus = fromDbusView({
				...DBUS_VIEW,
				model,
				...(firmwareRevision !== undefined ? { firmwareRevision } : {}),
			});

			expect(mmcli.additive?.availability_reason).toBeUndefined();
			expect(dbus.additive?.availability_reason).toBeUndefined();
		},
	);
});
