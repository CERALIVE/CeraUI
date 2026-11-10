/** Complete iproute2 replies proving a routing table has never been created. */
export function isFibTableAbsent(error: unknown): boolean {
	return (
		error instanceof Error &&
		(!("code" in error) || error.code === 2) &&
		"stderr" in error &&
		typeof error.stderr === "string" &&
		/^(?:(?:RTNETLINK answers: |Error: )?(?:ipv[46]: )?)?FIB table does not exist\.?(?:\n(?:Dump|Flush) terminated)?$/.test(
			error.stderr.trim(),
		)
	);
}
