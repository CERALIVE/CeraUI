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
  SIM PIN2 verification — the ONE modem operation that does not go through mmcli.

  WHY NOT mmcli / ModemManager. ModemManager has no PIN2 API of any kind, and
  this is a property of MM itself rather than of our wrapper. Verified two ways
  against MM 1.24.2:

   1. SOURCE. `org.freedesktop.ModemManager1.Sim` declares exactly SendPin(s),
      SendPuk(ss), EnablePin(sb), ChangePin(ss) and SetPreferredNetworks. There
      is no PIN-kind argument anywhere, and every backend hardcodes PIN1 —
      `QMI_UIM_PIN_ID_PIN1` and `QMI_DMS_UIM_PIN_ID_PIN` in mm-sim-qmi.c,
      `MBIM_PIN_TYPE_PIN1` in mm-sim-mbim.c, and a bare `AT+CPIN=` in the
      generic path. `mmcli` matches: --pin, --puk, --enable-pin, --disable-pin,
      --change-pin, and nothing else.
   2. LIVE BOARD. `busctl introspect` on a real RM530N-GL's SIM object returned
      that same five-method set, and `mmcli --help-all` that same option set.

  So routing PIN2 through mmcli is not a thing that can be made to work; the
  only route on this hardware is libqmi's UIM service, which does take a PIN
  identifier. qmicli is opened through the QMI PROXY (-p), which is the same
  multiplexer ModemManager itself connects through, so this shares the port with
  a running ModemManager instead of fighting it for exclusive access — confirmed
  on the board by reading card status with MM live.

  WHY THIS IS NOT AN EMERGENCY. An unverified PIN2 does not block registration
  or data. MM's own state machine says so verbatim ("We don't care about
  SIM-PIN2/SIM-PUK2 since the device is operational without it") and never moves
  such a modem to LOCKED. PIN2 gates the Fixed-Dialling-Number list and some
  call-cost settings. The board this was built against reports PIN1 *disabled*,
  the USIM application *ready*, and the modem *enabled*, with only PIN2
  outstanding — so the operator's service is unaffected either way.

  THE SUBMIT HAPPENS EXACTLY ONCE. PIN2 has its own small retry budget (3 on
  this SIM) and exhausting it requires a PUK2 the operator very likely does not
  have. So, mirroring unlockSimPin/unlockSimPuk: read the state first, refuse to
  submit unless PIN2 is genuinely awaiting verification, submit once, and on
  failure re-read ONLY to report the remaining count. There is deliberately no
  DMS-UIM fallback after a failed UIM attempt — a second submit would spend a
  second retry to answer a question the first already answered.
*/

import { logger } from "../../helpers/logger.ts";
import { run } from "../../helpers/run.ts";
import { describeCliError } from "../system/cli-parse.ts";

const qmicliBinary = "qmicli";

/** mmcli `-m` argument: a bare modem index or a ModemManager object path. */
const MODEM_PATH_RE = /^(?:\d+|\/org\/freedesktop\/ModemManager1\/Modem\/\d+)$/;

/** 4–8 digits, matching `simPin2UnlockInputSchema`. */
const PIN2_RE = /^\d{4,8}$/;

/**
 * A QMI control port as ModemManager names it in `modem.generic.ports`, e.g.
 * `cdc-wdm0 (qmi)`. The `(qmi)` suffix is the discriminator: the same modem also
 * exposes `(at)`, `(gps)` and `(net)` ports, none of which can carry this.
 */
const QMI_PORT_RE = /^(cdc-wdm\d+)\s+\(qmi\)$/;

/**
 * Per-application PIN2 facts from `qmicli --uim-get-card-status`.
 *
 * Scoping to an application is load-bearing rather than tidy. A live RM530N-GL
 * reports TWO applications — a `usim` whose PIN2 is enabled with 3 retries, and
 * an `isim` whose PIN2 is `not-initialized` with 0 retries — so a flat scan for
 * the first "PIN2 retries" line reports a healthy SIM as having no attempts
 * left, which reads as permanently blocked.
 */
export type Pin2CardState = {
	pin2State: string;
	pin2Retries?: number;
	puk2Retries?: number;
};

export type SimPin2UnlockResult =
	| { state: "success" }
	| { state: "wrong-pin2"; remainingAttempts?: number }
	| { state: "puk2-required" }
	| { state: "no-pin2-lock" }
	| { state: "unsupported" }
	| { state: "error" };

/**
 * Pick the QMI control port out of ModemManager's `modem.generic.ports` list.
 * Returns `undefined` for a modem with no QMI port at all (an MBIM or AT-only
 * device), which the caller reports as the typed `unsupported` terminal.
 */
export function findQmiPort(ports: ReadonlyArray<string>): string | undefined {
	for (const entry of ports) {
		const match = QMI_PORT_RE.exec(entry.trim());
		if (match?.[1] !== undefined) {
			return match[1];
		}
	}
	return undefined;
}

/**
 * Parse the USIM application's PIN2 block out of `--uim-get-card-status` output.
 *
 * The output is an indentation-structured tree, so this walks it statefully:
 * `Application type:` opens a new application scope and the PIN2 lines that
 * follow belong to it. Only the `usim` application is reported (see
 * {@link Pin2CardState}); a card with no USIM application yields `undefined`.
 */
export function parsePin2CardState(stdout: string): Pin2CardState | undefined {
	let inUsim = false;
	let result: Pin2CardState | undefined;

	for (const rawLine of stdout.split("\n")) {
		const line = rawLine.trim();

		const typeMatch = /^Application type:\s+'(\w+)/.exec(line);
		if (typeMatch) {
			inUsim = typeMatch[1] === "usim";
			continue;
		}
		if (!inUsim) continue;

		const stateMatch = /^PIN2 state:\s+'([^']+)'/.exec(line);
		if (stateMatch?.[1] !== undefined) {
			result = { pin2State: stateMatch[1] };
			continue;
		}
		if (!result) continue;

		const pinRetries = /^PIN2 retries:\s+'(\d+)'/.exec(line);
		if (pinRetries?.[1] !== undefined) {
			result.pin2Retries = Number.parseInt(pinRetries[1], 10);
			continue;
		}
		const pukRetries = /^PUK2 retries:\s+'(\d+)'/.exec(line);
		if (pukRetries?.[1] !== undefined) {
			result.puk2Retries = Number.parseInt(pukRetries[1], 10);
		}
	}

	return result;
}

/**
 * Classify a card state into a terminal WITHOUT submitting anything.
 * `undefined` means "PIN2 is genuinely awaiting verification, go ahead".
 */
export function pin2PreflightVerdict(
	card: Pin2CardState,
): SimPin2UnlockResult | undefined {
	if (card.pin2State.includes("blocked")) {
		return { state: "puk2-required" };
	}
	// `enabled-not-verified` is the only state a PIN2 submit can act on.
	// `disabled`, `enabled-verified` and `not-initialized` all mean there is
	// nothing here for the operator to enter.
	if (card.pin2State !== "enabled-not-verified") {
		return { state: "no-pin2-lock" };
	}
	return undefined;
}

async function readCardState(
	qmiPort: string,
): Promise<Pin2CardState | undefined> {
	try {
		const stdout = await run(qmicliBinary, [
			"-p",
			"-d",
			`/dev/${qmiPort}`,
			"--uim-get-card-status",
		]);
		return parsePin2CardState(stdout);
	} catch (err) {
		logger.error(`sim-pin2 card status read failed: ${describeCliError(err)}`);
		return undefined;
	}
}

/**
 * Submit PIN2 over the QMI UIM service.
 *
 * The code rides INSIDE the argv token (`--uim-verify-pin=PIN2,<code>`) because
 * that is the option's grammar; `run()`'s redactor covers that shape, so the
 * debug log shows `--uim-verify-pin=***`. The rejection thrown on a non-zero
 * exit embeds the full argv, so callers must never log it verbatim.
 */
async function sendPin2(qmiPort: string, pin2: string): Promise<void> {
	await run(qmicliBinary, [
		"-p",
		"-d",
		`/dev/${qmiPort}`,
		`--uim-verify-pin=PIN2,${pin2}`,
	]);
}

/**
 * Verify a SIM's PIN2 and classify the outcome.
 *
 * `ports` is ModemManager's own `modem.generic.ports` list for the modem — the
 * QMI device node is derived from it rather than guessed, so a board carrying
 * several modems can never have one's PIN2 submitted to another's card.
 */
export async function unlockSimPin2(
	modemPath: string,
	pin2: string,
	ports: ReadonlyArray<string>,
): Promise<SimPin2UnlockResult> {
	// Defense in depth: the RPC schema constrains both, but this is an exported
	// helper — reject anything that could escape the argv boundary.
	if (!MODEM_PATH_RE.test(modemPath) || !PIN2_RE.test(pin2)) {
		logger.warn("unlockSimPin2: rejected invalid modem path / pin2 shape");
		return { state: "error" };
	}

	const qmiPort = findQmiPort(ports);
	if (qmiPort === undefined) {
		// Not a fault: an MBIM or AT-only modem has no PIN2 route on this device,
		// and ModemManager offers none either. Say so instead of failing generically.
		return { state: "unsupported" };
	}

	const before = await readCardState(qmiPort);
	if (!before) {
		return { state: "error" };
	}

	const preflight = pin2PreflightVerdict(before);
	if (preflight) {
		return preflight;
	}

	try {
		await sendPin2(qmiPort, pin2);
		return { state: "success" };
	} catch {
		// Deliberately secret-free: the rejection's message embeds the argv, and
		// qmicli's stderr can echo the request, so neither is logged.
		logger.warn(
			`SIM PIN2 verification rejected for modem ${modemPath} (re-checking card state)`,
		);

		const after = await readCardState(qmiPort);
		if (after) {
			if (after.pin2State.includes("blocked")) {
				return { state: "puk2-required" };
			}
			if (after.pin2Retries !== undefined) {
				return { state: "wrong-pin2", remainingAttempts: after.pin2Retries };
			}
		}
		return { state: "wrong-pin2" };
	}
}
