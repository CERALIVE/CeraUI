import { expect, test } from "bun:test";
import { buildRedactor } from "../modules/device-logs/redaction.ts";

test("literal secrets are case-sensitive, longest-first and never interpreted as regexes", () => {
	const redact = buildRedactor([
		{ kind: "key", value: "a.b$" },
		{ kind: "long", value: "a.b$MORE" },
		{ kind: "overlap", value: "b$MORE!" },
	]);
	expect(redact.text("a.b$MORE! a.b$ A.B$ aXb$")).toEqual({
		text: "[REDACTED:long]! [REDACTED:key] A.B$ aXb$",
		redactions: 2,
	});
});

test("empty and short secrets do not consume input or mask ordinary text", () => {
	const redact = buildRedactor(
		["", "a", "ab", "abc"].map((value) => ({ kind: "short", value })),
	);
	expect(redact.text("abc abcabc")).toEqual({
		text: "abc abcabc",
		redactions: 0,
	});
	expect(redact.structured("abc")).toBeUndefined();
});

test.each([
	'key/"\n秘密',
	"abc\u061a",
	"abc\u0640",
	String.raw`\^$.*+?()[]{}|`,
	"a\0b!",
])("every occurrence is masked across encodings: %j", (value) => {
	const forms = [
		value,
		JSON.stringify(value).slice(1, -1),
		encodeURIComponent(value),
		encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, (part) =>
			part.toLowerCase(),
		),
		Buffer.from(value).toString("base64"),
		Buffer.from(value).toString("base64url"),
	];
	const redact = buildRedactor([{ kind: "key", value }]);
	for (const form of forms) {
		expect(redact.text(`before ${form}${form} after`)).toEqual({
			text: "before [REDACTED:key][REDACTED:key] after",
			redactions: 2,
		});
	}
});

test.each(["a", "a0", "a9", "a_", `a${"b".repeat(31)}`])(
	"valid kind boundary %s stays intact in its replacement marker",
	(kind) => {
		expect(buildRedactor([{ kind, value: "planted" }]).text("planted")).toEqual(
			{
				text: `[REDACTED:${kind}]`,
				redactions: 1,
			},
		);
	},
);

test("duplicates keep the first kind without masking a replacement again", () => {
	const redact = buildRedactor([
		{ kind: "first", value: "secret" },
		{ kind: "second", value: "secret" },
	]);
	expect(redact.text("secretsecret")).toEqual({
		text: "[REDACTED:first][REDACTED:first]",
		redactions: 2,
	});
});

test.each([
	["490154203237518", "[ID]"],
	["001010123456789", "[ID]"],
	["8934071100276980483", "[ICCID]"],
	["89340711002769804830", "[ICCID]"],
	["aa:bb:cc:dd:ee:ff", "aa:bb:cc:**:**:**"],
	["AA-BB-CC-DD-EE-FF", "AA-BB-CC-**-**-**"],
	["00:00:00:00:00:00", "00:00:00:**:**:**"],
	["99:99:99:99:99:99", "99:99:99:**:**:**"],
	["22:22:22:22:22:22", "22:22:22:**:**:**"],
	["8.8.8.8", "[IP]"],
	["1.1.1.1", "[IP]"],
	["172.15.255.255", "[IP]"],
	["172.32.0.0", "[IP]"],
	["192.167.255.255", "[IP]"],
	["192.169.0.0", "[IP]"],
	["100.63.255.255", "[IP]"],
	["100.128.0.0", "[IP]"],
	["169.253.255.255", "[IP]"],
	["169.255.0.0", "[IP]"],
	["126.255.255.255", "[IP]"],
	["128.0.0.0", "[IP]"],
	["2000::", "[IP]"],
	["3FFF:0:0:0:0:0:0:a", "[IP]"],
	["2600:1::abcd", "[IP]"],
	["2001:db8::192.168.1.10", "[IP]"],
	["2001:db8::8.8.8.8", "[IP]"],
	["2001:db8::1%eth0", "[IP]"],
	["https://[2001:db8::1%25wwan0]:8080/p", "https://[IP]:8080/p"],
	["peer 2001:db8::1.", "peer [IP]."],
	["10.0000, -20.12345", "[GPS]"],
	["+90.0000, +180.0000", "[GPS]"],
	["-90.0000,-180.0000", "[GPS]"],
	["1.0000,2.0000", "[GPS]"],
	["090.0000,010.0000", "[GPS]"],
	["Bearer token-._~+/==", "[REDACTED:token]"],
	["bEaReR\nanother", "[REDACTED:token]"],
	["v4.public.abc_DEF-123", "[REDACTED:token]"],
	["v12.local.abcdef", "[REDACTED:token]"],
	["v0.public.abcdef", "[REDACTED:token]"],
	["v9.public.abcdef", "[REDACTED:token]"],
	["eyJabc.def.ghi", "[REDACTED:token]"],
	["eyJ0A9.0A9.0A9", "[REDACTED:token]"],
])(
	"masks one supported shape %s and counts one replacement",
	(input, output) => {
		expect(buildRedactor([]).text(`before ${input} after`)).toEqual({
			text: `before ${output} after`,
			redactions: 1,
		});
	},
);

test.each([
	"192.168.1.10",
	"10.255.255.255",
	"172.16.0.0",
	"172.31.255.255",
	"127.0.0.1",
	"127.255.255.255",
	"169.254.0.1",
	"100.64.0.0",
	"100.127.255.255",
	"fe80::1%eth0",
	"febf::1",
	"fc00::aa:bb:cc:dd:ee:ff",
	"fd00::8.8.8.8",
	"[fd00::1]:9000",
	"::1",
	"0:0:0:0:0:0:0:1",
	"4000::1",
	"2001:::23",
	"12001:db8::1",
	"256.1.1.1",
	"1.256.1.1",
	"1.1.256.1",
	"1.1.1.256",
	".1.1.1",
	"1..1.1",
	"0001.1.1.1",
	"1111.1.1.1",
	"1.1.1.0001",
	"1.1.1.1111",
	"12345678901234",
	"1234567890123456",
	"893407110027698048300",
	"7934071100276980483",
	"891234567890123456",
	"aa:bb:cc:dd:ee",
	"aa:bb-cc:dd:ee:ff",
	"zaa:bb:cc:dd:ee:ff",
	"aa:bb:cc:dd:ee:ffz",
	"10.123,20.1234",
	"10.1234,20.123",
	".1234,10.0000",
	"10.0000,.1234",
	"0001.0000,002.0000",
	"1.0000,0002.0000",
	"1090.0000,020.0000",
	"1.0000,2.00000.3",
	"91.0000,20.0000",
	"10.0000,181.0000",
	"v4.private.abcdef",
	"v.public.abcdef",
	"v4.public.",
	"notBearer token",
	"Bearerabc",
	"Bearer ",
	"Bearer ===",
	"eyJ.def.ghi",
	"eyJabc..ghi",
	"eyJabc.def.",
	"null",
	"1.4.4",
	"example.com",
	"",
])("preserves excluded addresses and malformed shapes %j", (input) => {
	expect(buildRedactor([]).text(input)).toEqual({ text: input, redactions: 0 });
});

test("combined masking counts only performed replacements without leaking known values", () => {
	const redact = buildRedactor([
		{ kind: "stream", value: "stream-secret" },
		{ kind: "ssh", value: "ssh-password" },
	]);
	expect(
		redact.text(
			"stream-secret ssh-password 490154203237518 8934071100276980483 aa:bb:cc:dd:ee:ff 8.8.8.8 192.168.1.10",
		),
	).toEqual({
		text: "[REDACTED:stream] [REDACTED:ssh] [ID] [ICCID] aa:bb:cc:**:**:** [IP] 192.168.1.10",
		redactions: 6,
	});
});

test.each([
	"abcdabcdabcdabcdabcdabcdabcdabcd",
	"abcd",
	"1700000000000",
	"2026.11.3",
	"true",
])(
	"structured fields reject an exact known secret %s with a constant error",
	(value) => {
		const redact = buildRedactor([{ kind: "key", value }]);
		const field =
			value === "1700000000000"
				? 1_700_000_000_000
				: value === "true"
					? true
					: value;
		expect(() => redact.structured(field)).toThrow("READ_FAILED");
		try {
			redact.structured(field);
		} catch (error) {
			expect(error).toMatchObject({
				message: "READ_FAILED",
				code: "READ_FAILED",
			});
			expect(String(error)).not.toContain(value);
			expect(error).not.toHaveProperty("cause");
		}
	},
);

test("a secret superstring does not collide with an identifier it merely contains", () => {
	const redact = buildRedactor([{ kind: "key", value: "prefix-boot-suffix" }]);
	expect(redact.structured("boot")).toBeUndefined();
	expect(redact.structured(null)).toBeUndefined();
	expect(redact.text("prefix-boot-suffix")).toEqual({
		text: "[REDACTED:key]",
		redactions: 1,
	});
});

test("structured checks reset their matcher after a caught collision", () => {
	const redactor = buildRedactor([{ kind: "key", value: "planted" }]);
	for (let n = 0; n < 4; n++)
		expect(() => redactor.structured("before planted after")).toThrow(
			"READ_FAILED",
		);
	expect(
		buildRedactor([{ kind: "key", value: "null" }]).structured(null),
	).toBeUndefined();
});

test("a later overlapping group merges with its immediate predecessor", () => {
	const redactor = buildRedactor([
		{ kind: "first", value: "standalone" },
		{ kind: "key", value: "abcd" },
	]);
	expect(redactor.text("standalone v4.public.abcd_tail")).toEqual({
		text: "[REDACTED:first] [REDACTED:key]",
		redactions: 2,
	});
});

test.each(["a".repeat(65_537), "é".repeat(32_769)])(
	"oversized secret dictionaries fail before compiling their patterns",
	(value) => {
		expect(() => buildRedactor([{ kind: "key", value }])).toThrow(
			"READ_FAILED",
		);
	},
);

test("the dictionary budget counts UTF-8 bytes cumulatively and accepts its exact boundary", () => {
	const first = "a".repeat(65_532);
	const secrets = [
		{ kind: "key", value: first },
		{ kind: "other", value: "bbbb" },
	];
	expect(buildRedactor(secrets).text(first)).toEqual({
		text: "[REDACTED:key]",
		redactions: 1,
	});
	expect(() =>
		buildRedactor([...secrets, { kind: "third", value: "cccc" }]),
	).toThrow("READ_FAILED");
	expect(
		buildRedactor([{ kind: "key", value: "é".repeat(32_768) }]).text(
			"é".repeat(32_768),
		),
	).toEqual({ text: "[REDACTED:key]", redactions: 1 });
});

test("hostile kinds fail without copying any input into the exception", () => {
	for (const kind of ["\nSECRET", "bad]secret", "", "A", "a".repeat(33)]) {
		expect(() => buildRedactor([{ kind, value: "planted-secret" }])).toThrow(
			"READ_FAILED",
		);
	}
});

test("large literal inputs stay literal and finite", () => {
	const value = "[x]+".repeat(4096);
	expect(buildRedactor([{ kind: "large", value }]).text(value)).toEqual({
		text: "[REDACTED:large]",
		redactions: 1,
	});
});

test.each(["\ud800secret", "secret\udfff"])(
	"malformed Unicode secrets fail with the constant read error",
	(value) => {
		expect(() => buildRedactor([{ kind: "key", value }])).toThrow(
			"READ_FAILED",
		);
	},
);

test.each([
	{
		secrets: [],
		input: "v4.public.123456789012345_tail",
		output: "[REDACTED:token]",
	},
	{
		secrets: [],
		input: "eyJabc.123456789012345.tail",
		output: "[REDACTED:token]",
	},
	{
		secrets: [],
		input: "Bearer 123456789012345_tail",
		output: "[REDACTED:token]",
	},
	{
		secrets: [{ kind: "key", value: "abcd" }],
		input: "v4.public.abcd_tail",
		output: "[REDACTED:key]",
	},
	{
		secrets: [{ kind: "key", value: "v4.public.abcd_tail" }],
		input: "v4.public.abcd_tail",
		output: "[REDACTED:key]",
	},
	{
		secrets: [{ kind: "key", value: "prefix Bearer abcd" }],
		input: "prefix Bearer abcdTAIL",
		output: "[REDACTED:key]",
	},
	{
		secrets: [
			{ kind: "first", value: "aaaa" },
			{ kind: "second", value: "zzzz" },
		],
		input: "v4.public.aaaa_zzzz",
		output: "[REDACTED:first]",
	},
])(
	"token masks cannot be defeated by an overlapping literal or identifier: $input",
	({ secrets, input, output }) => {
		expect(buildRedactor(secrets).text(input)).toEqual({
			text: output,
			redactions: 1,
		});
	},
);
