import { expect, it } from "bun:test";
import { sanitizeAptDiagnostic } from "../modules/system/apt-all-diagnostics.ts";

it.each([
	["folded-credential", "Authorization: Bearer\n ALPHA9384"],
	["tab continuation", "Authorization: Bearer\n\tALPHA9384"],
	[
		"three-line value",
		"Authorization: Bearer\n ALPHA9384\n BRAVO8273\n CHARLIE7162",
	],
	["next stderr line", "Authorization:\nALPHA9384"],
	["CRLF", "Authorization: Bearer\r\n ALPHA9384"],
	["CR", "Authorization: Bearer\r ALPHA9384"],
	["unicode line separator", "Authorization: Bearer\u2028 ALPHA9384"],
	["unicode paragraph separator", "Authorization: Bearer\u2029 ALPHA9384"],
	["folded assignment", "password=\n ALPHA9384\n BRAVO8273"],
	["folded environment", "API_KEY=\n ALPHA9384"],
	["split private key marker", "private\u2028key:\n ALPHA9384"],
	["split API key marker", "api\u2029key=\n ALPHA9384"],
	["bare bearer", "Bearer\n ALPHA9384"],
	["bare token", "token:\n ALPHA9384"],
	["folded JWT", "eyJfixture.\n ALPHA9384\n BRAVO8273"],
	["folded PASETO", "v4.public.\n ALPHA9384\n BRAVO8273"],
	[
		"PEM continuation",
		"-----BEGIN PRIVATE KEY-----\nALPHA9384\n-----END PRIVATE KEY-----\n BRAVO8273",
	],
	["obfuscated PEM", "-----BE\u0000GIN PRIVATE KEY-----\nALPHA9384"],
	[
		"folded userinfo URL",
		"https://user:\n ALPHA9384@example.invalid/x\n BRAVO8273",
	],
	["URL then header", "https://example.invalid/x\nAuthorization:\n ALPHA9384"],
])(
	"suppresses marked continuation bytes when stderr contains %s",
	(_name, input) => {
		// Given: every named value is synthetic and spans a potentially folded record.
		// When: the entire stderr crosses the production sanitizer once.
		const detail = sanitizeAptDiagnostic(input);
		// Then: none of the marked value fragments can survive.
		expect(detail).toContain("[REDACTED");
		expect(detail).not.toMatch(/ALPHA9384|BRAVO8273|CHARLIE7162/);
	},
);

it("redacts before truncation when a marker follows a long benign prefix", () => {
	// Given
	const input = `${"e".repeat(650)} password=ALPHA9384\n BRAVO8273`;
	// When
	const detail = sanitizeAptDiagnostic(input);
	// Then: truncation cannot erase the marker before detection.
	expect(detail).toBe("[REDACTED]");
});

it("preserves benign unicode-separated diagnostics when no secret is marked", () => {
	// Given
	const input = "E: alpha\u2028beta\u2029gamma\r\ndelta\repsilon\nzeta";
	// When
	const detail = sanitizeAptDiagnostic(input);
	// Then
	expect(detail).toBe("E: alpha beta gamma delta epsilon zeta");
});
