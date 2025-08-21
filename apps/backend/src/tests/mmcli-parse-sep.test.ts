import { expect, test } from "bun:test";
import { mmcliParseSep } from "../modules/modems/mmcli.ts";

test("mmcli-parse-sep", () => {
	const testData = `modem.dbus-path                                 : /org/freedesktop/ModemManager1/Modem/0
modem.generic.device-identifier                 : sid01230j0wasd9h2f34ionasdf
modem.generic.manufacturer                      : Fibocom Wireless Inc.
modem.generic.model                             : L850-GL
modem.generic.revision                          : 18500.5001.00.04.26.22
modem.generic.carrier-configuration             : --
modem.generic.hardware-revision                 : V1.0.4
modem.generic.supported-capabilities.length     : 1
modem.generic.supported-capabilities.value[1]   : gsm-umts, lte
modem.generic.current-capabilities.length       : 1
modem.generic.current-capabilities.value[1]     : gsm-umts, lte
modem.generic.equipment-identifier              : 012345678901234
modem.generic.device                            : /sys/devices/platform/fc800000.usb/usb1/1-1/1-1.4
modem.generic.drivers.length                    : 2
modem.generic.drivers.value[1]                  : cdc_acm
modem.generic.drivers.value[2]                  : cdc_mbim
modem.generic.plugin                            : fibocom
modem.generic.primary-port                      : cdc-wdm0
modem.generic.ports.length                      : 5
modem.generic.ports.value[1]                    : cdc-wdm0 (mbim)
modem.generic.ports.value[2]                    : ttyACM0 (at)
modem.generic.ports.value[3]                    : ttyACM1 (ignored)
modem.generic.ports.value[4]                    : ttyACM2 (at)
modem.generic.ports.value[5]                    : wwan0 (net)
modem.generic.own-numbers.length                : 1
modem.generic.own-numbers.value[1]              : 01234567890
modem.generic.unlock-required                   : sim-pin2
modem.generic.unlock-retries.length             : 1
modem.generic.unlock-retries.value[1]           : sim-pin2 (3)
modem.generic.state                             : connected
modem.generic.state-failed-reason               : --
modem.generic.power-state                       : on
modem.generic.access-technologies.length        : 1
modem.generic.access-technologies.value[1]      : lte
modem.generic.signal-quality.value              : 41
modem.generic.signal-quality.recent             : no
modem.generic.supported-modes.length            : 5
modem.generic.supported-modes.value[1]          : allowed: 3g; preferred: none
modem.generic.supported-modes.value[2]          : allowed: 4g; preferred: none
modem.generic.supported-modes.value[3]          : allowed: 3g, 4g; preferred: none
modem.generic.supported-modes.value[4]          : allowed: 3g, 4g; preferred: 3g
modem.generic.supported-modes.value[5]          : allowed: 3g, 4g; preferred: 4g
modem.generic.current-modes                     : allowed: 3g, 4g; preferred: 4g
modem.generic.supported-bands.length            : 24
modem.generic.supported-bands.value[1]          : utran-1
modem.generic.supported-bands.value[2]          : utran-4
modem.generic.current-bands.length              : 24
modem.generic.current-bands.value[1]            : utran-1
modem.generic.current-bands.value[2]            : utran-4
modem.generic.supported-ip-families.length      : 3
modem.generic.supported-ip-families.value[1]    : ipv4
modem.generic.supported-ip-families.value[2]    : ipv6
modem.generic.supported-ip-families.value[3]    : ipv4v6
modem.3gpp.imei                                 : 0123123123123
modem.3gpp.enabled-locks.length                 : 1
modem.3gpp.enabled-locks.value[1]               : fixed-dialing
modem.3gpp.operator-code                        : 123456
modem.3gpp.operator-name                        : provider.tld
modem.3gpp.registration-state                   : home
modem.3gpp.packet-service-state                 : attached
modem.3gpp.eps.ue-mode-operation                : csps-2
modem.3gpp.eps.initial-bearer.dbus-path         : /org/freedesktop/ModemManager1/Bearer/0
modem.3gpp.eps.initial-bearer.settings.apn      : --
modem.cdma.meid                                 : --
modem.generic.sim                               : /org/freedesktop/ModemManager1/SIM/0
modem.generic.primary-sim-slot                  : --
modem.generic.sim-slots                         : --
modem.generic.bearers.length                    : 2
modem.generic.bearers.value[1]                  : /org/freedesktop/ModemManager1/Bearer/2
modem.generic.bearers.value[2]                  : /org/freedesktop/ModemManager1/Bearer/1`;

	const result = mmcliParseSep(testData);

	expect(result).toEqual({
		"modem.dbus-path": "/org/freedesktop/ModemManager1/Modem/0",
		"modem.generic.device-identifier": "sid01230j0wasd9h2f34ionasdf",
		"modem.generic.manufacturer": "Fibocom Wireless Inc.",
		"modem.generic.model": "L850-GL",
		"modem.generic.revision": "18500.5001.00.04.26.22",
		"modem.generic.hardware-revision": "V1.0.4",
		"modem.generic.supported-capabilities": ["gsm-umts, lte"],
		"modem.generic.current-capabilities": ["gsm-umts, lte"],
		"modem.generic.equipment-identifier": "012345678901234",
		"modem.generic.device": "/sys/devices/platform/fc800000.usb/usb1/1-1/1-1.4",
		"modem.generic.drivers": ["cdc_acm", "cdc_mbim"],
		"modem.generic.plugin": "fibocom",
		"modem.generic.primary-port": "cdc-wdm0",
		"modem.generic.ports": [
			"cdc-wdm0 (mbim)",
			"ttyACM0 (at)",
			"ttyACM1 (ignored)",
			"ttyACM2 (at)",
			"wwan0 (net)",
		],
		"modem.generic.own-numbers": ["01234567890"],
		"modem.generic.unlock-required": "sim-pin2",
		"modem.generic.unlock-retries": ["sim-pin2 (3)"],
		"modem.generic.state": "connected",
		"modem.generic.power-state": "on",
		"modem.generic.access-technologies": ["lte"],
		"modem.generic.signal-quality.value": "41",
		"modem.generic.signal-quality.recent": "no",
		"modem.generic.supported-modes": [
			"allowed: 3g; preferred: none",
			"allowed: 4g; preferred: none",
			"allowed: 3g, 4g; preferred: none",
			"allowed: 3g, 4g; preferred: 3g",
			"allowed: 3g, 4g; preferred: 4g",
		],
		"modem.generic.current-modes": "allowed: 3g, 4g; preferred: 4g",
		"modem.generic.supported-bands": ["utran-1", "utran-4"],
		"modem.generic.current-bands": ["utran-1", "utran-4"],
		"modem.generic.supported-ip-families": ["ipv4", "ipv6", "ipv4v6"],
		"modem.3gpp.imei": "0123123123123",
		"modem.3gpp.enabled-locks": ["fixed-dialing"],
		"modem.3gpp.operator-code": "123456",
		"modem.3gpp.operator-name": "provider.tld",
		"modem.3gpp.registration-state": "home",
		"modem.3gpp.packet-service-state": "attached",
		"modem.3gpp.eps.ue-mode-operation": "csps-2",
		"modem.3gpp.eps.initial-bearer.dbus-path":
			"/org/freedesktop/ModemManager1/Bearer/0",
		"modem.generic.sim": "/org/freedesktop/ModemManager1/SIM/0",
		"modem.generic.bearers": [
			"/org/freedesktop/ModemManager1/Bearer/2",
			"/org/freedesktop/ModemManager1/Bearer/1",
		],
	});
});
