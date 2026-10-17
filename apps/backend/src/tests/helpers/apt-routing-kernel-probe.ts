export function aptKernelTestAvailability(probe: {
	readonly code: number;
	readonly stderr: string;
}): { readonly available: boolean; readonly suffix: string } {
	const available = probe.code === 0;
	return {
		available,
		suffix: available
			? ""
			: ` (SKIP: user/network namespace with id maps unavailable: ${probe.stderr.trim()})`,
	};
}
