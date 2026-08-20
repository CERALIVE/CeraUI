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

/*
  Hardware naming for ModemManager-managed modems.

  WHY THIS EXISTS: a modem's `manufacturer` / `model` are whatever its firmware
  answers to ModemManager's identity query, and some firmware answers garbage.
  Board-measured on the bench (2026-08-17), a Qualcomm reference-design QMI stick
  (`05c6:9091`, IMEI 868837088254863) reports, verbatim:

      manufacturer: 1
      model: 0
      firmware revision: HIMI_U01_MODEM_V1.0  1  [Sep 09 2015 10:00:00]

  The row title is built as `<model> - <last 5 IMEI digits>`, so the operator saw
  a modem called "0 - 54863" — two numbers, neither of which names anything.

  The rule below is deliberately NARROW. A false positive is worse than the bug:
  it would replace a LEGITIMATE short model name with a fallback. The three other
  modems on the same bench report `RM530N-GL`, `SIMCOM_SIM7600G-H`, `FM350-GL` —
  multi-character alphanumeric SKUs, nothing like a bare integer — so "a bare
  numeral of at most four digits" flags the measured garbage and cannot reach any
  real SKU shape.

  NEVER FABRICATED: every fallback below is a string mmcli itself reported for
  that device. In particular the udev hwdb entry for this exact VID:PID is NOT
  used and must not be: `05c6:9091` resolves to "Intex Aqua Fish & Jolla C
  Diagnostic Mode", a shared Qualcomm reference-design id registered under an
  unrelated product. Displaying it would make the row confidently WRONG, which is
  worse than unhelpful.
*/

/**
 * A bare numeral, at most four digits — the measured garbage-identity shape
 * (`"1"`, `"0"`). Length-capped so a real numeric-ish designation could never be
 * swallowed whole, and anchored so `SIM7600` and friends never match.
 */
const BARE_NUMERAL_RE = /^\d{1,4}$/;

/** mmcli prints `--` for a field the device left empty. */
const MMCLI_EMPTY = "--";

/**
 * Does this manufacturer/model string identify anything?
 *
 * `true` means the string is absent, empty, mmcli's `--` placeholder, or a bare
 * numeral — i.e. it cannot name a vendor or a product and must not be displayed
 * as one.
 */
export function isUninformativeIdentity(value: string | undefined): boolean {
	const trimmed = value?.trim();
	if (trimmed === undefined || trimmed === "" || trimmed === MMCLI_EMPTY) {
		return true;
	}
	return BARE_NUMERAL_RE.test(trimmed);
}

/**
 * The displayable part of a firmware revision, or `undefined` when the revision
 * cannot serve as a name either.
 *
 * mmcli hands back the modem's `AT+CGMR` answer verbatim, and this device pads a
 * build stamp onto the same line: `HIMI_U01_MODEM_V1.0  1  [Sep 09 2015
 * 10:00:00]`. Only the leading token is a name; the rest is a timestamp that
 * would make the row unreadable. The real modems' revisions
 * (`RM530NGLAAR05A01M4G`, `LE20B04SIM7600G22`) survive this untouched.
 *
 * The letter requirement is the same "is this a name?" test as above: the FM350
 * reports `81600.0000.00.19.17.10`, and falling back from one number soup to
 * another would not help anybody.
 */
export function firmwareIdentityLabel(
	revision: string | undefined,
): string | undefined {
	const trimmed = revision?.trim();
	if (!trimmed || trimmed === MMCLI_EMPTY) return undefined;
	const withoutBuildStamp = trimmed.replace(/\s*\[[^\]]*]\s*$/, "").trim();
	const head = withoutBuildStamp.split(/\s{2,}/)[0]?.trim() ?? "";
	if (head.length < 3) return undefined;
	if (!/[A-Za-z]/.test(head)) return undefined;
	return head;
}

/** The mmcli-reported identity fields a row title can honestly be built from. */
export type MmcliHardwareIdentity = {
	/** `modem.generic.model` */
	readonly model?: string | undefined;
	/** `modem.generic.manufacturer` */
	readonly manufacturer?: string | undefined;
	/** `modem.generic.revision` */
	readonly firmwareRevision?: string | undefined;
	/** `modem.generic.equipment-identifier` (the IMEI). */
	readonly equipmentId?: string | undefined;
};

/**
 * Last-resort label. Not a vendor claim and not a name — it states the ONE thing
 * that is certainly true when every identity field the device published is
 * garbage, and leaves the IMEI tail to do the identifying.
 */
const UNNAMED_MODEM_LABEL = "Cellular modem";

/**
 * The hardware label: the device's own model, or the best remaining
 * device-reported string when the model does not name anything.
 *
 * Order — model, then firmware revision, then manufacturer. The firmware string
 * outranks the manufacturer because it identifies the PRODUCT (`HIMI_U01_MODEM`
 * is the module family) where a manufacturer only identifies a vendor; a row
 * that says which module is plugged in is more useful than one that says who
 * made it. When the model is informative nothing else is consulted at all, so
 * every correctly-behaved modem keeps exactly the title it had before.
 */
export function modemHardwareLabel(identity: MmcliHardwareIdentity): string {
	const model = identity.model?.trim();
	if (!isUninformativeIdentity(model) && model !== undefined) return model;

	const firmware = firmwareIdentityLabel(identity.firmwareRevision);
	if (firmware !== undefined) return firmware;

	const manufacturer = identity.manufacturer?.trim();
	if (!isUninformativeIdentity(manufacturer) && manufacturer !== undefined) {
		return manufacturer;
	}

	return UNNAMED_MODEM_LABEL;
}

/** How many IMEI digits the title carries — enough to tell two same-SKU units apart. */
const IMEI_TAIL_LENGTH = 5;

/**
 * The row title for an mmcli-managed modem: `<label> - <IMEI tail>`.
 *
 * The IMEI tail is the disambiguator for two units of the same SKU (this bench
 * has such pairs). It is dropped entirely when the device published no IMEI —
 * the previous code appended a bare `" - "` in that case.
 */
export function modemHardwareName(identity: MmcliHardwareIdentity): string {
	const label = modemHardwareLabel(identity);
	const imei = identity.equipmentId?.trim();
	if (!imei || imei === MMCLI_EMPTY) return label;
	return `${label} - ${imei.slice(-IMEI_TAIL_LENGTH)}`;
}
