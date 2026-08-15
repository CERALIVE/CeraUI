import { describe, expect, it } from "bun:test";

import type { LocaleCode } from "../src/locale-lifecycle.js";
import { NON_BASE_LOCALES, readCatalog } from "./helpers/catalog.js";

// ---------------------------------------------------------------------------
// Translation-quality gate for the exact keys added by todos 6, 10, 11, 12, 13
// of capability-first-live-experience (todo 18's sweep target — see notepad
// sections "Todo 6" / "Todo 10" / "Todo 11" / "Todo 12" / "Todo 13").
//
// Proves every new key resolves to a REAL, non-empty, per-locale translation —
// not an English placeholder silently copy-pasted across all 10 locale files —
// and that no literal interpolation syntax (`{...}` / `{{...}}`) leaks into the
// value (all of these keys are param-free).
//
// Repointed by plan todo 23 from the legacy dictionaries onto `messages/*.json`,
// the catalogs the app compiles and serves. Key access is a direct lookup rather
// than a nested walk, because the catalogs are keyed by the verbatim dotted key.
// ---------------------------------------------------------------------------

const ALL_NON_EN_LOCALES: readonly LocaleCode[] = NON_BASE_LOCALES;

function at(locale: LocaleCode, path: string): unknown {
	return readCatalog(locale)[path];
}

// The full key inventory the todo-18 spec names, per originating todo.
const NEW_KEYS = [
	{ path: "audio.sources.noAudio", todo: 6 },
	{ path: "audio.sources.pipelineDefault", todo: 6 },
	{ path: "live.encoder.axisSelected", todo: 10 },
	{ path: "live.encoder.axisDeviceMax", todo: 10 },
	{ path: "live.education.reason.unsupportedAtResolution", todo: 10 },
	{ path: "live.source.sourceMax", todo: 11 },
	{ path: "live.networkIngest.includesAudio", todo: 12 },
	{ path: "live.source.audioEmbedded", todo: 13 },
	{ path: "live.comingSoon.embeddedAudio", todo: 13 },
] as const;

// Locales the spec explicitly requires a REAL (≠ en) value from — a coincidental
// same-spelling short word in ja/ko/zh/ar/hi/pt-BR is not itself suspicious, but
// es/de/fr sharing Latin script with en makes an accidental copy-paste far more
// plausible, so those three are the load-bearing "proves it's translated" check.
const MUST_DIFFER_FROM_EN: readonly LocaleCode[] = ["es", "de", "fr"];

const INTERPOLATION_RESIDUE_RE = /\{\{?[^}]*\}\}?/;

describe("translation-quality gate: keys added by todos 6/10-13", () => {
	for (const { path, todo } of NEW_KEYS) {
		describe(`${path} (todo ${todo})`, () => {
			const enValue = at("en", path);

			it("exists on en as a non-empty string", () => {
				expect(typeof enValue).toBe("string");
				expect((enValue as string).length).toBeGreaterThan(0);
			});

			for (const locale of ALL_NON_EN_LOCALES) {
				it(`${locale}: resolves to a non-empty string with no interpolation residue`, () => {
					const value = at(locale, path);
					expect(typeof value).toBe("string");
					const str = value as string;
					expect(str.length).toBeGreaterThan(0);
					expect(str).not.toMatch(INTERPOLATION_RESIDUE_RE);
				});
			}

			for (const locale of MUST_DIFFER_FROM_EN) {
				it(`${locale}: is a REAL translation, not the English value copy-pasted`, () => {
					expect(at(locale, path)).not.toBe(enValue);
				});
			}
		});
	}
});
