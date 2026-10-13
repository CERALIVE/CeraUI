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
	if (properties.get("LoadState") === "not-found") {
		const inactive = (key: string, allowed: readonly string[]) => {
			const value = properties.get(key);
			return value === undefined || allowed.includes(value);
		};
		if (
			!inactive("ActiveState", ["", "inactive"]) ||
			!inactive("SubState", ["", "dead"]) ||
			!inactive("ControlGroup", [""]) ||
			!inactive("MainPID", ["", "0"]) ||
			!inactive("ControlPID", ["", "0"]) ||
			!inactive("Job", ["", "0"])
		)
			return null;
	}
	return properties;
}

export function parseSystemdExitFields(
	properties: ReadonlyMap<string, string>,
): {
	readonly mainCode: number;
	readonly mainStatus: number;
} | null {
	const code = properties.get("ExecMainCode");
	const status = properties.get("ExecMainStatus");
	if (
		code === undefined ||
		status === undefined ||
		!/^\d+$/.test(code) ||
		!/^\d+$/.test(status)
	)
		return null;
	const mainCode = Number(code);
	const mainStatus = Number(status);
	if (
		mainCode < 1 ||
		mainCode > 3 ||
		mainStatus > 255 ||
		(mainCode !== 1 && mainStatus === 0)
	)
		return null;
	return { mainCode, mainStatus };
}
