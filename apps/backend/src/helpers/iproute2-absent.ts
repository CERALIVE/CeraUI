const absentDiagnostics = {
	read: /^Error: ipv[46]: FIB table does not exist\.\nDump terminated$/,
	flush: /^Error: ipv[46]: FIB table does not exist\.\nFlush terminated$/,
	"json-read": /^Error: ipv[46]: FIB table does not exist\.\nDump terminated$/,
} as const;

/** Steering tolerates only a complete, empty failed observation for its operation. */
export function isFibTableAbsent(
	error: unknown,
	operation: keyof typeof absentDiagnostics,
): boolean {
	if (
		!(error instanceof Error) ||
		!("code" in error) ||
		error.code !== 2 ||
		!("stdout" in error) ||
		typeof error.stdout !== "string" ||
		!("stderr" in error) ||
		typeof error.stderr !== "string"
	)
		return false;
	const stdout = error.stdout.trim();
	return (
		(operation === "json-read"
			? stdout === "" || stdout === "[]"
			: stdout === "") &&
		absentDiagnostics[operation].test(
			error.stderr.replaceAll("\r\n", "\n").trim(),
		)
	);
}
