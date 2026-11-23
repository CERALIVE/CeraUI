import { isIPv6 } from "node:net";
import {
	BundleReadError,
	buildRedactor,
} from "../../modules/device-logs/redaction.ts";
import {
	classifyBundleRecords,
	journalBootIds,
} from "./support-bundle-records.ts";

const bootId = /^[0-9a-f]{32}$/;
// Mirror bundle-body.ts: SD_ID128 for s/b, unpadded lowercase PRIx64 for i/m/t/x.
const nativeCursor =
	/^s=[0-9a-f]{32};i=(?:0|[1-9a-f][0-9a-f]{0,15});b=([0-9a-f]{32});m=(?:0|[1-9a-f][0-9a-f]{0,15});t=(?:0|[1-9a-f][0-9a-f]{0,15});x=(?:0|[1-9a-f][0-9a-f]{0,15})$/;
const embeddedCursor = new RegExp(`\\b${nativeCursor.source.slice(1, -1)}\\b`);

const shapes = [
	["bearer", /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i],
	["jwt", /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/],
	["paseto", /v[0-9]+\.(?:public|local)\.[A-Za-z0-9_-]+/],
	[
		"apiKey",
		/\b(?:sk_(?:live|test)_[a-z0-9]{16,}|AKIA[A-Z0-9]{16}|AIza[A-Za-z0-9_-]{35}|gh[pousr]_[A-Za-z0-9]{30,})\b/i,
	],
	[
		"sshKey",
		/-----BEGIN (?:OPENSSH |RSA |EC |DSA |ENCRYPTED )?PRIVATE KEY-----|\b(?:ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-nistp\d+)\s+[A-Za-z0-9+/]{20,}={0,2}/,
	],
] as const;

const labels = (
	[
		[
			"credentialField",
			/password(?:[_.-]?hash)?|passwd|psk|(?:pairing[_.-]?)?secret|(?:(?:access|auth|refresh|api|bearer|session)[_.-]?)?token|passphrase|(?:api|remote|stream|ingest|bcrp|pairing)[_.-]?key|ssh[_.-]?pass|srt[_.-]?streamid|auth_tokens\.json|authorization/,
		],
		["ssid", /(?:wifi[_.-]?)?ssid/],
		["hostname", /host[_.-]?name|_HOSTNAME/],
		["serial", /(?:(?:modem|device)[_.-]?)?serial(?:[_.-]?(?:number|no))?/],
		["subscriber", /imei|imsi|iccid|msisdn|subscriber[_.-]?id/],
	] as const
).map(
	([rule, pattern]) =>
		[
			rule,
			new RegExp(`^(?:${pattern.source})$`, "i"),
			new RegExp(
				`\\b(?:${pattern.source})["']?\\s*[:=]\\s*(?:"([^"]*)"|'([^']*)'|([^\\s,;}"']+))`,
				"gi",
			),
		] as const,
);
const isMasked =
	/^(?:\[(?:REDACTED(?::[a-z0-9_-]+)?|ID|ICCID|IP)\]|\*+|<redacted>|null|undefined|true|false|none)$/i;

function localV4(a: number, b: number) {
	return (
		a === 10 ||
		a === 127 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127)
	);
}

function networkRules(text: string) {
	// Classify containment using original offsets; a zone can itself contain IPv4.
	const addresses: {
		start: number;
		end: number;
		masked: boolean;
		local: boolean;
	}[] = [];
	for (const match of text.matchAll(
		/(?<![\w.])(?<![\da-f:]:)[\da-f]{0,4}:[\da-f:.]+(?:%[\w.~-]+)?(?![\w:%]|\.[\w:.])/gi,
	)) {
		const address = match[0].replace(/\.+$/, "");
		const host = address.split("%", 1)[0] ?? "";
		if (!isIPv6(host)) continue;
		const canonical = new URL(`http://[${host}]`).hostname;
		const mapped = /^\[::ffff:([\da-f]+):[\da-f]+\]$/.exec(canonical);
		const translated = /^\[64:ff9b::(?:([\da-f]+):)?[\da-f]*\]$/.exec(
			canonical,
		);
		const high = Number.parseInt(mapped?.[1] ?? translated?.[1] ?? "0", 16);
		addresses.push({
			start: match.index,
			end: match.index + address.length,
			masked:
				/^[23][\da-f]{3}:/i.test(host) ||
				(Boolean(mapped || translated) && !localV4(high >>> 8, high & 255)),
			local: /^(?:f[cd][\da-f]{2}|fe[89ab][\da-f]):/i.test(host),
		});
	}
	const containing = (match: RegExpMatchArray) =>
		addresses.find(
			({ start, end }) =>
				start <= (match.index ?? -1) &&
				(match.index ?? -1) + match[0].length <= end,
		);
	const ipv4 = [
		...text.matchAll(/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g),
	].some((match) => {
		const scope = containing(match);
		const [a = 0, b = 0, ...tail] = match[0].split(".").map(Number);
		return (
			!(scope?.masked || scope?.local) &&
			[a, b, ...tail].every((octet) => octet <= 255) &&
			!localV4(a, b)
		);
	});
	return {
		ipv4,
		ipv6: addresses.some(({ masked }) => masked),
		mac: [
			...text.matchAll(
				/\b[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}\b/gi,
			),
		].some((match) => !containing(match)),
	};
}

class JsonNumber {
	constructor(
		readonly source: string,
		readonly value: number,
	) {}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof JsonNumber)
	);
}

function object(value: unknown): Record<string, unknown> | undefined {
	return isRecord(value) ? value : undefined;
}

class ScanError extends Error {
	constructor(line: number) {
		super(`Invalid support bundle at line ${line}`);
	}
}

// JSON.parse validates syntax but collapses repeated keys before its reviver.
// On that validated line, only member-name strings can be followed by a colon.
function hasDuplicateMember(line: string): boolean {
	const objects: Set<string>[] = [];
	for (const [token, name] of line.matchAll(
		/[{}]|("(?:[^"\\]|\\.)*")(?=[\t\r ]*:)|"(?:[^"\\]|\\.)*"/g,
	)) {
		if (token === "{") objects.push(new Set());
		else if (token === "}") objects.pop();
		else if (name !== undefined) {
			const keys = objects.at(-1);
			const key: string = JSON.parse(name);
			if (keys?.has(key)) return true;
			keys?.add(key);
		}
	}
	return false;
}

/** Pass all decompressed members as NDJSON. Findings count fields per rule, not
 * occurrences; duplicateMember counts ambiguous records. No input is returned. */
export function scanSupportBundle(
	ndjson: string,
	heldValues: readonly string[] = [],
) {
	const counts = {
		numericId: 0,
		iccid: 0,
		heldValue: 0,
		credentialField: 0,
		bearer: 0,
		jwt: 0,
		paseto: 0,
		apiKey: 0,
		sshKey: 0,
		ipv4: 0,
		ipv6: 0,
		mac: 0,
		gps: 0,
		ssid: 0,
		hostname: 0,
		serial: 0,
		subscriber: 0,
		boot: 0,
		duplicateMember: 0,
		invalidRecord: 0,
	};
	const held = buildRedactor(
		heldValues.map((value) => ({ kind: "audit", value })),
	);
	const hasHeld = (value: string) => {
		try {
			held.structured(value);
			return false;
		} catch (error) {
			if (!(error instanceof BundleReadError) || error.reason !== "collision")
				throw error;
			return true;
		}
	};
	const lines = ndjson.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const records = lines.map((line, index) => {
		try {
			// Preserve decimal tokens that would otherwise round above MAX_SAFE_INTEGER.
			const value: unknown = JSON.parse(
				line,
				(
					_key: string,
					item: unknown,
					context?: { readonly source?: string },
				) =>
					typeof item === "number"
						? new JsonNumber(context?.source ?? String(item), item)
						: item,
			);
			const record = object(value);
			if (record) {
				if (hasDuplicateMember(line)) counts.duplicateMember++;
				return record;
			}
		} catch (error) {
			if (!(error instanceof SyntaxError)) throw error;
		}
		throw new ScanError(index + 1);
	});
	const unwrapNumbers = (value: unknown): unknown => {
		if (value instanceof JsonNumber) return value.value;
		if (Array.isArray(value)) return value.map(unwrapNumbers);
		if (isRecord(value))
			return Object.fromEntries(
				Object.entries(value).map(([key, item]) => [key, unwrapNumbers(item)]),
			);
		return value;
	};
	const wire = records.map((record) =>
		Object.fromEntries(
			Object.entries(record).map(([key, value]) => [key, unwrapNumbers(value)]),
		),
	);
	// A duplicate can hide a versions row or alter the boot of a journal row.
	// Continue scanning for leads, but grant no boot/cursor authority.
	const authoritativeBoots = counts.duplicateMember ? [] : journalBootIds(wire);
	const journalBoots = new Set(authoritativeBoots);
	const classifications = classifyBundleRecords(wire, authoritativeBoots);
	const knownBoots = new Set(journalBoots);
	for (const [index, record] of records.entries()) {
		if (classifications[index]?.invalid) continue;
		const id =
			record.section === "events" ? object(record.boot)?.bootId : undefined;
		if (typeof id === "string" && bootId.test(id)) knownBoots.add(id);
	}
	let exemptNumeric = 0;
	let ended = false;
	for (const [index, record] of records.entries()) {
		if (ended) throw new ScanError(index + 1);
		ended = record.section === "end" && typeof record.complete === "boolean";
		const classification = classifications[index];
		if (classification?.invalid) counts.invalidRecord++;
		const scannedBoot = classification?.scannedBoot;
		const event = object(record.event);
		const beforeHeld = counts.heldValue;
		function inspect(text: string, field: string, path: string) {
			let expected: unknown;
			if (record.section === "versions") {
				if (journalBoots.has(text)) {
					if (path === "exportedBy.bootId" || path === "bootId")
						expected = text;
					if (path === "versions.bootId") expected = record.bootId;
				}
			}
			if (record.section === "events") {
				if (path === "boot.bootId" || path === "event.bootId") expected = text;
				if (path === "boot.versions.bootId")
					expected = object(record.boot)?.bootId;
				if (
					(path === "event.params.previousBootId" &&
						event?.code === "device_started") ||
					(path === "event.params.bootId" &&
						event?.code === "previous_boot_unclean")
				)
					expected = text;
			}
			if (record.section === "journal" && path === "entry.bootId")
				expected = scannedBoot;
			const authorized = expected === text && knownBoots.has(text);
			const cursorField =
				record.section === "journal" && path === "entry.cursor";
			const native =
				cursorField &&
				scannedBoot !== undefined &&
				nativeCursor.exec(text)?.[1] === scannedBoot;
			const [b, duplicate] =
				cursorField && scannedBoot ? text.matchAll(/(?:^|;)b=([^;]*)/g) : [];
			const bootEnd =
				b && !duplicate && b[1] === scannedBoot ? b.index + b[0].length : 0;
			for (const [rule, pattern] of [
				["numericId", /(?<!\d)\d{15}(?!\d)/g],
				["iccid", /(?<!\d)89\d{17,18}(?!\d)/g],
			] as const) {
				let hit = false;
				for (const match of text.matchAll(pattern)) {
					if (
						native ||
						authorized ||
						(b &&
							bootEnd > 0 &&
							match.index >= bootEnd - (b[1]?.length ?? 0) &&
							match.index + match[0].length <= bootEnd)
					)
						exemptNumeric++;
					else hit = true;
				}
				if (hit) counts[rule]++;
			}
			const namedBoot =
				/^(?:previous)?boot[_.-]?id$/i.test(field) && bootId.test(text);
			const knownBoot = [...text.matchAll(/\b[0-9a-f]{32}\b/gi)].some(([id]) =>
				knownBoots.has(id.toLowerCase()),
			);
			const labeledBoot =
				/\b(?:previous[_.-]?)?boot[_.-]?id["']?\s*[:=]\s*["']?[0-9a-f]{32}\b/i.test(
					text,
				);
			if (
				!native &&
				(cursorField ||
					labeledBoot ||
					embeddedCursor.test(text) ||
					(!authorized && (namedBoot || knownBoot)))
			)
				counts.boot++;
			if (hasHeld(text)) counts.heldValue++;
			for (const [rule, pattern] of shapes)
				if (pattern.test(text)) counts[rule]++;
			for (const [rule, label, assignment] of labels) {
				if (
					(label.test(field) && text.trim() && !isMasked.test(text.trim())) ||
					[...text.matchAll(assignment)].some(([, dq, sq, word]) => {
						const value = (dq ?? sq ?? word ?? "").trim();
						return value !== "" && !isMasked.test(value);
					})
				)
					counts[rule]++;
			}
			const { ipv4, ipv6, mac } = networkRules(text);
			if (ipv4) counts.ipv4++;
			if (ipv6) counts.ipv6++;
			if (mac) counts.mac++;
			if (
				[
					...text.matchAll(
						/(?<![\d.])([+-]?\d{1,3}\.\d{4,})\s*,\s*([+-]?\d{1,3}\.\d{4,})(?![\d.])/g,
					),
				].some(
					([, lat, lon]) =>
						Math.abs(Number(lat)) <= 90 && Math.abs(Number(lon)) <= 180,
				)
			)
				counts.gps++;
		}
		function visit(value: unknown, field = "", path = "") {
			if (typeof value === "string" || value instanceof JsonNumber) {
				inspect(typeof value === "string" ? value : value.source, field, path);
			} else if (Array.isArray(value)) {
				for (const item of value) visit(item, field, `${path}[]`);
			} else if (isRecord(value)) {
				for (const [key, inner] of Object.entries(value)) {
					inspect(key, "", "");
					// Literal dots in keys must not impersonate a nested authorized field.
					visit(
						inner,
						key,
						`${path ? `${path}.` : ""}${key.replaceAll(".", "\\.")}`,
					);
				}
			}
		}
		visit(record);
		const raw = lines[index];
		if (beforeHeld === counts.heldValue && raw !== undefined && hasHeld(raw))
			counts.heldValue++;
	}
	if (!ended) throw new ScanError(records.length + 1);
	return { records: records.length, exemptNumeric, counts };
}
