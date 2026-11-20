import { z } from 'zod';

export const stateSchema = z.object({
	parent: z.string(),
	mac: z.string(),
	virtual: z.string(),
	ap: z.string().uuid(),
	uplink: z.string().uuid(),
	ssid: z.string(),
});

export type MountEntry = {
	point: string;
	options: string;
	fstype: string;
	superOptions: string;
};

/** The /proc/self/mountinfo entry covering path; the last of equal mount points shadows the rest. */
export function mountEntry(path: string, mountinfo: string): MountEntry | undefined {
	let best: MountEntry | undefined;
	for (const line of mountinfo.split('\n')) {
		const [left, right] = line.split(' - ');
		if (!left || !right) continue;
		const fields = left.split(' ');
		const point = (fields[4] ?? '').replace(/\\(\d{3})/g, (_, octal: string) =>
			String.fromCharCode(Number.parseInt(octal, 8)),
		);
		const [fstype = '', , superOptions = ''] = right.split(' ');
		const covers = point === '/' || path === point || path.startsWith(`${point}/`);
		if (covers && point.length >= (best?.point.length ?? 0))
			best = { point, options: fields[5] ?? '', fstype, superOptions };
	}
	return best;
}

/**
 * Per profile, the names of compared fields that differ (`keyfile-bytes` for the persisted file), then each
 * audited write on an unrelated profile. Values, secrets included, are never printed.
 */
export function profileFieldDiff(
	before: ReadonlyMap<string, string>,
	after: ReadonlyMap<string, string>,
	writes: readonly AuditRecord[] = [],
): string[] {
	const fields = (settings: string | undefined) =>
		new Map(
			(settings ?? '')
				.split('\n')
				.filter(Boolean)
				.map((line) => {
					const at = line.indexOf(':');
					return [line.slice(0, at), line.slice(at + 1)] as const;
				}),
		);
	const lines: string[] = [];
	for (const uuid of [...new Set([...before.keys(), ...after.keys()])].sort()) {
		const old = fields(before.get(uuid));
		const now = fields(after.get(uuid));
		const label = `${uuid} (${old.get('connection.id') ?? now.get('connection.id') ?? '?'})`;
		if (!before.has(uuid) || !after.has(uuid)) {
			lines.push(`${label}: profile ${before.has(uuid) ? 'removed' : 'added'}`);
			continue;
		}
		const changed = [...new Set([...old.keys(), ...now.keys()])]
			.filter((name) => old.get(name) !== now.get(name))
			.sort();
		if (changed.length) lines.push(`${label}: ${changed.join(', ')}`);
	}
	for (const write of writes) {
		const id =
			fields(before.get(write.uuid)).get('connection.id') ??
			fields(after.get(write.uuid)).get('connection.id') ??
			'?';
		lines.push(`${write.uuid} (${id}): audit ${write.op} by pid=${write.pid}`);
	}
	return lines;
}

export type AuditRecord = {
	at: number;
	op: string;
	uuid: string;
	pid: string;
	result: string;
};

const journalEntry = z.object({
	MESSAGE: z.unknown(),
	__REALTIME_TIMESTAMP: z.string(),
});

/** NetworkManager audit records from `journalctl -o json`, reduced to time (ms), op, uuid, pid and result. */
export function journalAudit(json: string): AuditRecord[] {
	return json
		.split('\n')
		.filter((line) => line.startsWith('{'))
		.flatMap((line) => {
			const entry = journalEntry.parse(JSON.parse(line));
			const message = typeof entry.MESSAGE === 'string' ? entry.MESSAGE : '';
			if (!message.includes('audit: ')) return [];
			const field = (name: string) =>
				message.match(new RegExp(`\\b${name}="?([^"\\s]*)"?`))?.[1] ?? '?';
			return [
				{
					at: Number(entry.__REALTIME_TIMESTAMP) / 1000,
					op: field('op'),
					uuid: field('uuid'),
					pid: field('pid'),
					result: field('result'),
				},
			];
		});
}

/** Writes NM audited on an unrelated UUID since `from` (ms): update, delete, an add over it, or a secrets clear. */
export function unrelatedProfileWrites(
	records: readonly AuditRecord[],
	unrelated: ReadonlySet<string>,
	from: number,
): AuditRecord[] {
	return records.filter(
		(record) =>
			record.at >= from &&
			unrelated.has(record.uuid) &&
			(record.op.startsWith('connection-update') ||
				[
					'connection-add',
					'connection-add-activate',
					'connection-delete',
					'connection-clear-secrets',
				].includes(record.op)),
	);
}

/**
 * A profile's comparable state: every non-secret nmcli field, plus the SHA-256 of its persisted keyfile
 * bytes. Secret fields read `<hidden>` or have a `-flags` sibling; their nmcli value follows secret
 * visibility after activation, so the keyfile bytes are their authority.
 */
export function profileSerialization(terse: string, keyfile: Uint8Array | undefined): string {
	// Activation timestamps and GENERAL describe runtime, not saved settings.
	const lines = terse
		.split('\n')
		.filter((line) => /^[a-z0-9-]+\./.test(line) && !line.startsWith('connection.timestamp:'));
	const names = new Set(lines.map((line) => line.slice(0, line.indexOf(':'))));
	const kept = lines.filter((line) => {
		const name = line.slice(0, line.indexOf(':'));
		return (
			line.slice(name.length + 1) !== '<hidden>' &&
			!names.has(`${name}-flags`) &&
			!names.has(`${name.replace(/\d+$/, '')}-flags`)
		);
	});
	const bytes = keyfile ? new Bun.CryptoHasher('sha256').update(keyfile).digest('hex') : 'none';
	return [...kept, `keyfile-bytes:${bytes}`].join('\n');
}

/** Distinct reasons the reconciler logged for mac; the intent-persistence error name is dropped. */
export function failedIntentReasons(lines: string[], mac: string): string[] {
	const marker = `Wi-Fi hotspot autoconnect failed for ${mac}`;
	const reasons = lines.flatMap((line) => {
		const at = line.indexOf(marker);
		const colon = at === -1 ? -1 : line.indexOf(': ', at + marker.length);
		if (colon === -1) return [];
		const reason = (line.slice(colon + 2).split('"')[0] ?? '').split('\u001b')[0]?.trim() ?? '';
		return [reason.startsWith('intent persistence') ? 'intent persistence' : reason];
	});
	return [...new Set(reasons)];
}
