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

// A "config loaded" line as the logger wrote it before ssh_pass, its hash and
// remote_key were redacted by key. None of these values is held any more.
const oldConfigLine = JSON.stringify({
	ts: "2026-01-01T00:00:00.000Z",
	level: "debug",
	msg: "config loaded",
	meta: {
		password: "[REDACTED]",
		ssh_pass: "old-ssh-pass-91c2",
		ssh_pass_hash: "$6$oldsalt$oldsshhash91c2",
		remote_key: "old-remote-key-91c2",
		pairing_secret: "[REDACTED]",
		ssh_persistent: false,
		video_passthrough: "auto",
	},
});
const oldConfigValues = [
	"old-ssh-pass-91c2",
	"oldsshhash91c2",
	"old-remote-key-91c2",
];

test.each([oldConfigLine, JSON.stringify({ message: oldConfigLine })])(
	"config credential fields are masked by name when their value is no longer held: %s",
	(line) => {
		const { text, redactions } = buildRedactor([]).text(line);
		for (const value of oldConfigValues) expect(text).not.toContain(value);
		expect(redactions).toBe(3);
		expect(text.match(/\[REDACTED:ssh\]/g)).toHaveLength(2);
		expect(text).toContain("[REDACTED:remote_key]");
		expect(text).toContain("video_passthrough");
		expect(text).toContain("auto");
	},
);

test("credential masking leaves ordinary fields and complete markers alone", () => {
	const line = JSON.stringify({
		video_passthrough: "auto",
		keyframe: "2",
		bypass: "on",
		ssh_persistent: "yes",
		stableKey: "keep",
		ssh_pass: "[REDACTED]",
		remote_key: "[REDACTED:remote_key]",
		password: "",
	});
	expect(buildRedactor([]).text(line)).toEqual({ text: line, redactions: 0 });
});

test("a value that only starts with a redaction marker is still masked", () => {
	const plain = JSON.stringify({
		remote_key: "[REDACTED]tail-of-old-remote-key",
		ssh_pass: "[REDACTED:ssh]x-old-pass",
	});
	for (const line of [plain, JSON.stringify({ message: plain })]) {
		const { text, redactions } = buildRedactor([]).text(line);
		expect(text).not.toContain("tail-of-old-remote-key");
		expect(text).not.toContain("x-old-pass");
		expect(redactions).toBe(2);
	}
});

test("password_hash, pairing_secret, camelCase and dotted credential keys are masked", () => {
	const fields = {
		password_hash: "$2b$10$old-ui-hash-77",
		pairing_secret: "old-pairing-77",
		sshPassHash: "$6$s$old-camel-hash-77",
		remoteKey: "old-camel-remote-77",
		"remote.key": "old-dotted-remote-77",
		"ssh.pass": "old-dotted-ssh-77",
	};
	const plain = JSON.stringify(fields);
	for (const line of [plain, JSON.stringify({ message: plain })]) {
		const { text, redactions } = buildRedactor([]).text(line);
		for (const value of Object.values(fields))
			expect(text).not.toContain(value);
		expect(redactions).toBe(6);
		expect(text).toContain("[REDACTED:password]");
		expect(text).toContain("[REDACTED:pairing]");
		expect(text.match(/\[REDACTED:ssh\]/g)).toHaveLength(2);
		expect(text.match(/\[REDACTED:remote_key\]/g)).toHaveLength(2);
	}
});

// Round-2 shapes: the walk follows parent keys, arrays and JSON inside JSON.
const nestedFields = {
	remote: { key: "nested-remote-r3" },
	ssh: { hash: "$6$s$nested-ssh-hash-r3", port: 22 },
	remote_keys: ["array-key-one-r3", "array-key-two-r3"],
	accounts: [{ ingest_key: "array-object-r3", name: "keep-name-r3" }],
	video: { key: "keep-video-key-r3" },
	remoteInfo: { commitHash: "keep-commit-r3" },
	stream: { keyCount: "keep-count-r3" },
};
const nestedValues = [
	"nested-remote-r3",
	"nested-ssh-hash-r3",
	"array-key-one-r3",
	"array-key-two-r3",
	"array-object-r3",
];
const keptValues = [
	"keep-name-r3",
	"keep-video-key-r3",
	"keep-commit-r3",
	"keep-count-r3",
];
const journalLine = JSON.stringify({ msg: "x", meta: nestedFields });

test.each([
	["text", "a journal line", journalLine],
	[
		"text",
		"twice-encoded JSON",
		JSON.stringify({ msg: "x", meta: { raw: journalLine } }),
	],
	["text", "a prefixed line", `backend said ${journalLine}`],
	["text", "pretty JSON", JSON.stringify({ meta: nestedFields }, null, 2)],
] as const)(
	"%s masks nested, array and qualified credentials in %s",
	(_method, _shape, line) => {
		const { text, redactions } = buildRedactor([]).text(line);
		for (const value of nestedValues) expect(text).not.toContain(value);
		for (const value of keptValues) expect(text).toContain(value);
		expect(redactions).toBe(nestedValues.length);
	},
);

test("an escaped member with an encoded newline before its value is masked when the text does not parse", () => {
	const line =
		'unit wrote {\\"ssh_pass\\":\\n \\"encoded-gap-r3\\"} and stopped';
	const { text, redactions } = buildRedactor([]).text(line);
	expect(text).not.toContain("encoded-gap-r3");
	expect(text).toContain('\\"[REDACTED:ssh]\\"');
	expect(redactions).toBe(1);
});

test("numbers, booleans and a value equal to a key name keep their place", () => {
	const line = JSON.stringify({
		meta: { pin: 1234, ssh_pass: "ssh_persistent", ssh_persistent: true },
	});
	const { text } = buildRedactor([]).text(line);
	expect(text).toContain('"pin":1234');
	expect(text).toContain('"ssh_persistent":true');
	expect(text).toContain('"ssh_pass":"[REDACTED:ssh]"');
});

test("a held literal inside a credential member keeps the member's quotes", () => {
	const line = JSON.stringify({
		meta: { remote_key: "prefix-held-literal-r3-suffix" },
	});
	{
		const redact = buildRedactor([{ kind: "key", value: "held-literal-r3" }]);
		const { text } = redact.text(line);
		expect(text).not.toContain("held-literal-r3");
		expect(text).not.toContain("suffix");
		expect(JSON.parse(text)).toHaveProperty("meta.remote_key");
		expect(text).toMatch(/"remote_key":"\[REDACTED(?::[a-z_]+)?\]"/);
	}
});

test("a line repeating one credential value thousands of times is masked in linear time", () => {
	const line = JSON.stringify({
		msg: "x",
		meta: { ssh_pass: Array.from({ length: 4000 }, () => "a") },
	});
	expect(line.length).toBeGreaterThan(16_000);
	const started = performance.now();
	const { text, redactions } = buildRedactor([]).text(line);
	const elapsed = performance.now() - started;
	expect(redactions).toBe(4000);
	expect(text).not.toContain('"a"');
	// Was several seconds per line when each copy rescanned the whole text.
	expect(elapsed).toBeLessThan(500);
});
