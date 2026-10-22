const capture = await Bun.file(
	new URL("../fixtures/apt/opi-nginx-20261022.txt", import.meta.url),
).text();

// Only capture framing is removed; command output (including final spaces) stays intact.
export function opiAptSection(name: string): string {
	const start = `@@${name}\n`;
	const end = `@@${name}-RC=0\n`;
	const offset = capture.indexOf(start);
	const limit = capture.indexOf(end, offset + start.length);
	if (offset < 0 || limit < 0)
		throw new Error(`missing capture section ${name}`);
	return capture.slice(offset + start.length, limit);
}

export const opiNginxPairs = [
	{ name: "nginx", version: "1.26.3-3+deb13u10" },
	{ name: "nginx-common", version: "1.26.3-3+deb13u10" },
	{ name: "nginx-light", version: "1.26.3-3+deb13u10" },
] as const;
