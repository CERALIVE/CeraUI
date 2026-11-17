import type {
	LogBundleManifest,
	LogExportOutput,
	VersionContext,
} from "@ceraui/rpc/schemas";

export const BUNDLE_BOOT = "66d8d1808694489b8c3a3fb4795cab24";

export const RUNNING: VersionContext = {
	bootId: BUNDLE_BOOT,
	osImage: "2026.11.0",
	slot: "a",
	board: "rk3588",
	boardModel: null,
	ceraui: "2026.11.2",
	engine: "2026.11.1",
	senderVersion: null,
	kernel: "6.1.84",
	bun: "1.4.4",
};

export function bundleManifest(journalEntries: number): LogBundleManifest {
	return {
		sections: [
			{ id: "versions", entries: 2, redactions: 0 },
			{ id: "settings", entries: 6, redactions: 1 },
			{ id: "events", entries: 14, redactions: 0 },
			{ id: "journal", entries: journalEntries, redactions: 9 },
		],
		exportedBy: RUNNING,
		boots: [
			{ bootId: BUNDLE_BOOT, versions: RUNNING },
			{ bootId: "0123456789abcdef0123456789abcdef", versions: null },
		],
	};
}

// Tickets as the device mints them: its own route and 32 random bytes in lowercase hex.
export const EXPORT_TICKET = {
	ok: true,
	url: "/api/logs/export?ticket=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	expiresAt: 60_000,
} as const satisfies LogExportOutput;

export const BUNDLE_TICKET = {
	ok: true,
	url: "/api/logs/bundle?ticket=fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
	expiresAt: 60_000,
} as const satisfies LogExportOutput;

/**
 * Awaits a signal the test subscribed to before acting, so a broken flow fails
 * here within 2 s instead of hanging until the 20 s test timeout.
 */
export async function signalled<T>(
	signal: Promise<T>,
	what: string,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error(`${what} did not happen within 2 s`)),
			2_000,
		);
	});
	try {
		return await Promise.race([signal, late]);
	} finally {
		clearTimeout(timer);
	}
}
