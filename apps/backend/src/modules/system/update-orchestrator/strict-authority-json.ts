export class AuthorityJsonError extends SyntaxError {
	override readonly name = "AuthorityJsonError";
	constructor(
		readonly reason: "duplicate_member" | "invalid_json" | "invalid_utf8",
		options?: ErrorOptions,
	) {
		super(reason, options);
	}
}

export function decodeAuthorityUtf8(bytes: Uint8Array): string {
	try {
		// Keep a BOM visible: JSON's grammar must reject it, not silently strip it.
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
			bytes,
		);
	} catch (cause) {
		throw new AuthorityJsonError("invalid_utf8", { cause });
	}
}

/** Scan raw member names before a schema can see JSON.parse's last-wins object. */
export function parseAuthorityJson(raw: string): unknown {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new AuthorityJsonError("invalid_json");
	}
	const objects: (Set<string> | null)[] = [];
	for (let at = 0; at < raw.length; at++) {
		const char = raw[at];
		if (char === "{") objects.push(new Set());
		else if (char === "[") objects.push(null);
		else if (char === "}" || char === "]") objects.pop();
		else if (char === '"') {
			const start = at++;
			while (at < raw.length && raw[at] !== '"') {
				if (raw[at] === "\\") at++;
				at++;
			}
			let next = at + 1;
			while (/^[\t\n\r ]$/.test(raw[next] ?? "")) next++;
			if (raw[next] !== ":") continue;
			const members = objects.at(-1);
			const key: unknown = JSON.parse(raw.slice(start, at + 1));
			if (!members || typeof key !== "string")
				throw new AuthorityJsonError("invalid_json");
			if (members.has(key)) throw new AuthorityJsonError("duplicate_member");
			members.add(key);
		}
	}
	return parsed;
}
