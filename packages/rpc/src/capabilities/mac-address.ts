const MAC_RE = /^[0-9a-f]{2}(?::[0-9a-f]{2}){5}$/;

/** Canonicalize a six-octet MAC address, rejecting the all-zero placeholder. */
export function normalizeMacAddress(raw: string | undefined): string | undefined {
	if (!raw) return undefined;
	const mac = raw.trim().toLowerCase();
	return MAC_RE.test(mac) && mac !== '00:00:00:00:00:00' ? mac : undefined;
}
