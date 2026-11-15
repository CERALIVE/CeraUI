export function nmcliFieldNames(args: readonly string[]): string[] {
	const named = args.includes("--fields") && args.includes("multiline");
	const at = args.indexOf(named ? "--fields" : "--get-values");
	return at < 0 ? [] : (args[at + 1] ?? "").split(",");
}

/** Render fixture data using the selected real NM output format. */
export function nmcliFieldOutput(
	args: readonly string[],
	value: (field: string) => string | undefined,
): string {
	const named = args.includes("--fields") && args.includes("multiline");
	return nmcliFieldNames(args)
		.map((field) => {
			const observed = value(field);
			return named ? `${field}:${observed ?? ""}` : (observed ?? "");
		})
		.join("\n");
}

export function replaceNmcliField(
	args: readonly string[],
	stdout: string,
	field: string,
	value: string,
): string {
	const lines = stdout.split("\n");
	const named = args.includes("--fields") && args.includes("multiline");
	const at = named
		? lines.findIndex((line) => line.startsWith(`${field}:`))
		: nmcliFieldNames(args).indexOf(field);
	if (at < 0) throw new Error("Missing fixture field");
	lines[at] = named ? `${field}:${value}` : value;
	return lines.join("\n");
}
