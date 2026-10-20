export function observationAbsent(
	error: unknown,
	scope: "path" | "process",
): boolean {
	return (
		error instanceof Error &&
		"code" in error &&
		(error.code === "ENOENT" || (scope === "process" && error.code === "ESRCH"))
	);
}
