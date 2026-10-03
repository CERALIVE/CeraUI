export function parseOsStageSystemdProperties(
	output: string,
): ReadonlyMap<string, string> | null {
	const properties = new Map<string, string>();
	for (const line of output.trim().split("\n")) {
		const at = line.indexOf("=");
		const key = line.slice(0, at);
		if (at < 1 || !/^[A-Za-z][A-Za-z0-9]*$/.test(key) || properties.has(key))
			return null;
		properties.set(key, line.slice(at + 1));
	}
	return properties;
}
