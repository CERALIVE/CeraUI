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
