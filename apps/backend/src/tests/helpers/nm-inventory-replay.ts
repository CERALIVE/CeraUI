import { assertNmDeviceShowFields } from "./nm-device-show-fixture.ts";

// The option order matters for prefixes (e.g. -o and bare - match overview).
const options = [
	["-overview", false],
	["-terse", false],
	["-pretty", false],
	["-mode", true],
	["-escape", true],
	["-fields", true],
	["-get-values", true],
	["-nocheck", false],
] as const;

// shortcut: replay only all-device `device show` with captured selectors;
// extend for other commands, per-device queries or ANSI only if needed.
export function inventoryQuery(argv: readonly string[]) {
	let style: "normal" | "terse" | "pretty" = "normal";
	let mode: "multiline" | "tabular" | undefined;
	let getValues = false;
	let escapeValues = true;
	let selector: string | undefined;
	let i = 1;
	for (; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg?.startsWith("-")) break;
		if (arg === "--") {
			i++;
			break;
		}
		const token = arg.startsWith("--") ? arg.slice(1) : arg;
		const equals = token.indexOf("=");
		const name = equals < 0 ? token : token.slice(0, equals);
		// Only value-taking options accept '='. argv values are already
		// tokenized; quotes, backslashes and any further '=' remain literal.
		const option = options.find(([pattern, takesValue]) =>
			pattern.startsWith(takesValue ? name : token),
		);
		if (!option) return;
		const [pattern, takesValue] = option;
		const value = takesValue
			? equals < 0
				? argv[++i]
				: token.slice(equals + 1)
			: undefined;
		if (takesValue && value === undefined) return;
		switch (pattern) {
			case "-terse":
			case "-pretty":
				// Repeating either print style or combining both is an input error.
				if (style !== "normal") return;
				style = pattern === "-terse" ? "terse" : "pretty";
				break;
			case "-mode":
				if (!value) return;
				if ("multiline".startsWith(value)) mode = "multiline";
				else if ("tabular".startsWith(value)) mode = "tabular";
				else return;
				break;
			case "-escape":
				if (!value) return;
				if ("yes".startsWith(value)) escapeValues = true;
				else if ("no".startsWith(value)) escapeValues = false;
				else return;
				break;
			case "-get-values":
				getValues = true;
				style = "terse";
				selector = value;
				break;
			case "-fields":
				// Unlike mode and escape, only the final field selector is validated.
				selector = value;
				break;
			case "-overview": // Ignored by nmcli when fields are explicitly set.
			case "-nocheck": // Accepted for backward compatibility.
				break;
		}
	}
	const object = argv[i];
	const command = argv[i + 1];
	// `s` dispatches to status, not show.
	if (
		i + 2 !== argv.length ||
		!object ||
		!"device".startsWith(object) ||
		!command?.startsWith("sh") ||
		!"show".startsWith(command)
	)
		return;

	// nmcli compares ASCII case-insensitively and skips empty comma entries.
	const upper = selector?.replace(/[a-z]/g, (letter) => letter.toUpperCase());
	const fields =
		upper === "ALL" || upper === "COMMON"
			? ["GENERAL"]
			: upper
					?.split(",")
					.map((field) => field.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, ""))
					.filter(Boolean);
	return {
		style,
		mode: mode ?? (getValues ? "tabular" : "multiline"),
		escapeValues,
		fields,
	};
}

export function inventoryReply(
	argv: readonly string[],
	...records: readonly string[]
) {
	const query = inventoryQuery(argv);
	if (!query)
		return { exitCode: 2, stdout: "", stderr: "Invalid inventory invocation" };
	// For broad queries, HWADDR suffices to witness an incompatible extra row.
	const requested = (query.fields ?? ["GENERAL"]).flatMap((field) =>
		field === "GENERAL"
			? ["GENERAL.DEVICE", "GENERAL.TYPE", "GENERAL.HWADDR", "GENERAL.STATE"]
			: [field],
	);
	if (requested.length === 0) return { exitCode: 0, stdout: "", stderr: "" };
	try {
		assertNmDeviceShowFields(requested.join(","));
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === 2))
			throw error;
		return { exitCode: error.code, stdout: "", stderr: error.message };
	}
	return {
		exitCode: 0,
		stdout: records
			.map((record) => {
				const values = new Map(
					record.split("\n").map((line) => {
						const separator = line.indexOf(":");
						return [line.slice(0, separator), line.slice(separator + 1)];
					}),
				);
				return requested
					.map((field) => {
						// An allowed field still appears if the fixture has no value.
						const value =
							values.get(field) ??
							(field === "GENERAL.HWADDR" ? "02:00:00:00:00:00" : "--");
						if (query.mode === "tabular") {
							// Dotted selectors print separate sections, one value per row.
							return query.style === "terse" && query.escapeValues
								? value.replace(/[:\\]/g, "\\$&")
								: value;
						}
						const label = `${field}:`;
						return `${query.style === "terse" ? label : label.padEnd(40)}${value}`;
					})
					.join("\n");
			})
			.join("\n\n"),
		stderr: "",
	};
}
