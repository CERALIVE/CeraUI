import { isIPv6 } from "node:net";

export class BundleReadError extends Error {
	constructor(readonly code: "READ_FAILED" | "BUSY" = "READ_FAILED") {
		super(code);
	}
}

const percentCase = (value: string) =>
	value.replace(/%[0-9a-f]{2}/gi, (part) => part.toLowerCase());

interface Redactor {
	structured(value: string | number | boolean | null): void;
	text(value: string): { readonly text: string; readonly redactions: number };
}

export function buildRedactor(
	secrets: readonly { readonly kind: string; readonly value: string }[],
): Redactor {
	const literals = new Map<string, string>();
	let secretBytes = 0;
	for (const { kind, value } of secrets) {
		if (!/^[a-z][a-z0-9_]{0,31}$/.test(kind)) throw new BundleReadError();
		if (value.length < 4) continue;
		secretBytes += Buffer.byteLength(value);
		if (secretBytes > 64 * 1024) throw new BundleReadError();
		const bytes = Buffer.from(value);
		let uri: string;
		try {
			uri = encodeURIComponent(value);
		} catch {
			throw new BundleReadError();
		}
		for (const form of [
			value,
			JSON.stringify(value).slice(1, -1),
			uri,
			bytes.toString("base64"),
			bytes.toString("base64url"),
		]) {
			const key = percentCase(form);
			if (!literals.has(key)) literals.set(key, `[REDACTED:${kind}]`);
		}
	}
	const alternatives = [...literals.keys()]
		.sort((a, b) => b.length - a.length)
		.map((value) =>
			value
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/%[0-9a-f]{2}/g, (part) =>
					part.replace(
						/[a-f]/g,
						(letter) => `[${letter}${letter.toUpperCase()}]`,
					),
				),
		);
	const exact = alternatives.length
		? new RegExp(alternatives.join("|"), "g")
		: null;
	return {
		structured(value: string | number | boolean | null) {
			if (exact === null || value === null) return;
			exact.lastIndex = 0;
			if (exact.test(String(value))) throw new BundleReadError();
		},
		text(value: string) {
			const spans: Array<{
				start: number;
				end: number;
				marker: string;
				known: boolean;
			}> = [];
			if (exact !== null) {
				for (const match of value.matchAll(exact))
					spans.push({
						start: match.index,
						end: match.index + match[0].length,
						marker: literals.get(percentCase(match[0])) ?? "",
						known: true,
					});
			}
			const addresses: Array<{ readonly start: number; readonly end: number }> =
				[];
			for (const match of value.matchAll(
				/(?<![\w.])(?<![\da-f:]:)[\da-f]{0,4}:[\da-f:.]+(?:%[\w.~-]+)?(?![\w:%]|\.[\w:.])/gi,
			)) {
				const address = match[0].replace(/\.+$/, "");
				const host = address.split("%", 1)[0] ?? "";
				if (!isIPv6(host)) continue;
				const start = match.index;
				const end = start + address.length;
				addresses.push({ start, end });
				if (/^[23][\da-f]{3}:/i.test(host)) {
					const bracketed = value[start - 1] === "[" && value[end] === "]";
					spans.push({
						start: bracketed ? start - 1 : start,
						end: bracketed ? end + 1 : end,
						marker: "[IP]",
						known: false,
					});
				}
			}
			const mask = (
				pattern: RegExp,
				replacement: (match: string) => string,
				addressFragment = false,
			) => {
				let addressIndex = 0;
				for (const match of value.matchAll(pattern)) {
					const end = match.index + match[0].length;
					if (addressFragment) {
						let address = addresses[addressIndex];
						while (address && address.end <= match.index)
							address = addresses[++addressIndex];
						if (address && address.start <= match.index && end <= address.end)
							continue;
					}
					const next = replacement(match[0]);
					if (next !== match[0])
						spans.push({
							start: match.index,
							end,
							marker: next,
							known: false,
						});
				}
			};
			mask(/(?<!\d)89\d{17,18}(?!\d)/g, () => "[ICCID]");
			mask(/(?<!\d)\d{15}(?!\d)/g, () => "[ID]");
			mask(
				/\b[0-9a-f]{2}([:-])[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\1[0-9a-f]{2}\b/gi,
				(match) => {
					const separator = match.charAt(2);
					return `${match.slice(0, 8)}${separator}**${separator}**${separator}**`;
				},
				true,
			);
			mask(
				/(?<![\d.])\d{1,3}(?:\.\d{1,3}){3}(?![\d.])/g,
				(match) => {
					const a = Number.parseInt(match, 10);
					const b = Number.parseInt(match.slice(match.indexOf(".") + 1), 10);
					if (
						match
							.split(".")
							.map(Number)
							.some((octet) => octet > 255) ||
						a === 10 ||
						a === 127 ||
						(a === 172 && b >= 16 && b <= 31) ||
						(a === 192 && b === 168) ||
						(a === 169 && b === 254) ||
						(a === 100 && b >= 64 && b <= 127)
					)
						return match;
					return "[IP]";
				},
				true,
			);
			mask(
				/(?<![\d.])[+-]?\d{1,3}\.\d{4,}\s*,\s*[+-]?\d{1,3}\.\d{4,}(?![\d.])/g,
				(match) => {
					const latitude = Number.parseFloat(match);
					const longitude = Number.parseFloat(
						match.slice(match.indexOf(",") + 1),
					);
					return Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
						? "[GPS]"
						: match;
				},
			);
			// Same value shapes as the logger, global here to count every occurrence.
			mask(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, () => "[REDACTED:token]");
			mask(
				/v[0-9]+\.(?:public|local)\.[A-Za-z0-9\-_]+/g,
				() => "[REDACTED:token]",
			);
			mask(
				/eyJ[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+/g,
				() => "[REDACTED:token]",
			);
			spans.sort((a, b) => a.start - b.start);
			const merged: typeof spans = [];
			for (const span of spans) {
				const previous = merged.at(-1);
				if (previous && span.start < previous.end) {
					previous.end = Math.max(previous.end, span.end);
					if (span.known && !previous.known) {
						previous.marker = span.marker;
						previous.known = true;
					}
				} else merged.push({ ...span });
			}
			let position = 0;
			const parts = merged.map((span) => {
				const part = value.slice(position, span.start) + span.marker;
				position = span.end;
				return part;
			});
			return {
				text: parts.join("") + value.slice(position),
				redactions: merged.length,
			};
		},
	};
}
