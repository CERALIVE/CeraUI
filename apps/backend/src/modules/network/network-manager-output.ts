/** Decode nmcli's escaped separators, including an even run of backslashes. */
export function nmcliParseSep(line: string): string[] {
	const values: string[] = [];
	let value = "";
	for (let index = 0; index < line.length; index++) {
		const char = line[index] ?? "";
		const next = line[index + 1];
		if (char === "\\" && (next === ":" || next === "\\")) {
			value += next;
			index++;
		} else if (char === ":") {
			values.push(value);
			value = "";
		} else value += char;
	}
	values.push(value);
	return values;
}

/** Absent sections contribute no lines. Only field names identify their values. */
export function parseNmcliFields(
	stdout: string,
	fields: readonly string[],
): ReadonlyMap<string, string> | undefined {
	const requested = fields.map((field) => field.toLowerCase());
	const row = new Map<string, string>();
	let current: string | undefined;
	let valueStart = 0;
	const finish = (end: number) => {
		if (current === undefined) return;
		const valueEnd =
			end > valueStart && stdout[end - 1] === "\n" ? end - 1 : end;
		row.set(current, stdout.slice(valueStart, valueEnd));
	};
	for (let start = 0; start < stdout.length; ) {
		const lf = stdout.indexOf("\n", start);
		const end = lf < 0 ? stdout.length : lf;
		const line = stdout.slice(start, end);
		const separator = line.indexOf(":");
		if (separator > 0) {
			const key = line.slice(0, separator).toLowerCase();
			const base = key.replace(/\[\d+\]$/, "");
			if (requested.includes(base)) {
				finish(start);
				if (row.has(key)) return undefined;
				current = key;
				valueStart = start + separator + 1;
			} else if (
				current === undefined ||
				/^[a-z0-9_.-]+(?:\[\d+\])?$/.test(key)
			) {
				return undefined;
			}
		} else if (current === undefined) {
			return undefined;
		}
		start = lf < 0 ? stdout.length : lf + 1;
	}
	finish(stdout.length);
	return row;
}
