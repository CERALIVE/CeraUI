/**
 * CeraLive operators are non-developers with no console or SSH access. A shell
 * command, a systemd unit name, or a raw ALSA device string in a user-facing
 * string is unactionable — it must be replaced by a pointer at the in-app log
 * viewer (Settings → System Logs). Found live during Wave H device QA, where a
 * stacked start-failure toast told an operator to run
 * `journalctl -u cerastream.service` and then quoted
 * `ALSA capture device 'hw:CARD=rockchiphdmiin' is busy or unavailable` verbatim.
 */
import { describe, expect, it } from "vitest";

import { ar, de, en, es, fr, hi, ja, ko, ptBR, zh } from "./helpers/catalog";

const LOCALES = { ar, de, en, es, fr, hi, ja, ko, "pt-BR": ptBR, zh };

const BANNED = [
	{ label: "journalctl", pattern: /journalctl/i },
	{ label: "systemctl", pattern: /systemctl/i },
	{ label: "a systemd unit name", pattern: /\b[\w-]+\.service\b/ },
	{ label: "a raw ALSA device string", pattern: /hw:CARD=/i },
	// Widened for the refusal taxonomy: each is a string from a layer a refusal
	// travels through — the engine speaks JSON-RPC, the modem stack shells out to
	// `mmcli`, the router providers read AT responses — and none is actionable by
	// an operator with no console.
	{
		label: "an mmcli/qmicli/mbimcli fragment",
		pattern: /\b(?:mm|qmi|mbim)cli\b/i,
	},
	{ label: "an AT command", pattern: /\bAT[+!][A-Z]/ },
	{ label: "a modem-manager D-Bus interface", pattern: /org\.freedesktop\./i },
	{ label: "a JSON-RPC envelope", pattern: /"jsonrpc"|\bjsonrpc\b/i },
	{ label: "a raw device node", pattern: /\/dev\/(?:tty|cdc-wdm|video|snd)/i },
	// A dotted i18n key that leaked into a VALUE — the exact shape an
	// interpolated lookup renders when its token has no copy.
	{
		label: "a dotted i18n key",
		pattern: /\bnetwork\.(?:modem|routerCellular)\./,
	},
];

function collectStrings(
	value: unknown,
	path: string,
	out: { path: string; text: string }[],
): void {
	if (typeof value === "string") {
		out.push({ path, text: value });
		return;
	}
	if (value === null || typeof value !== "object") return;
	for (const [key, child] of Object.entries(value)) {
		collectStrings(child, path === "" ? key : `${path}.${key}`, out);
	}
}

describe("operator-facing copy carries no ops internals", () => {
	it.each(Object.keys(LOCALES))("%s", (locale) => {
		const entries: { path: string; text: string }[] = [];
		collectStrings(LOCALES[locale as keyof typeof LOCALES], "", entries);
		expect(entries.length).toBeGreaterThan(0);

		const offenders = entries.flatMap(({ path, text }) =>
			BANNED.filter(({ pattern }) => pattern.test(text)).map(
				({ label }) => `${path}: ${label} — "${text}"`,
			),
		);

		expect(offenders).toEqual([]);
	});
});

describe("the sweep is falsifiable — every pattern trips on a planted string", () => {
	// A clean sweep proves nothing unless each detector can be shown to fire, so
	// the planted strings are the real shapes each pattern exists to catch.
	it.each([
		["journalctl", "Run journalctl to see why."],
		["systemctl", "Try systemctl restart."],
		["a systemd unit name", "See cerastream.service for details."],
		["a raw ALSA device string", "hw:CARD=rockchiphdmiin is busy."],
		["an mmcli/qmicli/mbimcli fragment", "mmcli -m 0 reported an error."],
		["an AT command", 'AT+GTUSBMODE=? returned "(40,41)".'],
		[
			"a modem-manager D-Bus interface",
			"org.freedesktop.ModemManager1 failed.",
		],
		["a JSON-RPC envelope", '{"jsonrpc":"2.0","error":{"code":-32000}}'],
		["a raw device node", "/dev/cdc-wdm0 did not answer."],
		["a dotted i18n key", "network.modem.refusal.deviceBusy"],
	])("%s", (label, planted) => {
		const caught = BANNED.filter(({ pattern }) => pattern.test(planted)).map(
			(entry) => entry.label,
		);
		expect(caught).toContain(label);
	});
});
