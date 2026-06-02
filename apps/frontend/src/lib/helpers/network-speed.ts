/**
 * Convert bytes per second to kilobits per second
 * Formula: (bytes * 8 bits/byte) / 1024 bits/kilobit
 */
export const convertBytesToKbids = (bytes: number): number => {
	return Math.round((bytes * 8) / 1024);
};

/**
 * Format throughput in kbps to human-readable string
 * - < 1000 kbps: "N kbps"
 * - >= 1000 kbps: "X.X Mbps" (one decimal place)
 * - null or non-finite: "—"
 */
export const formatThroughput = (kbps: number | null, _loc?: string): string => {
	if (kbps === null || !Number.isFinite(kbps)) {
		return '—';
	}

	if (kbps < 1000) {
		return `${Math.round(kbps)} kbps`;
	}

	const mbps = kbps / 1000;
	return `${mbps.toFixed(1)} Mbps`;
};

/**
 * Determine speed tier based on kbps
 * - null or < 1000 kbps: 'weak' (red)
 * - 1000 <= kbps < 5000: 'fair' (amber)
 * - >= 5000 kbps: 'good' (green)
 */
export const speedTier = (kbps: number | null): 'weak' | 'fair' | 'good' => {
	if (kbps === null) {
		return 'weak';
	}

	if (kbps < 1000) {
		return 'weak';
	}

	if (kbps < 5000) {
		return 'fair';
	}

	return 'good';
};
