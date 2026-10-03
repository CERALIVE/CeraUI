// Pure readers of kernel lock and process rows for the guardian lock proof.

export type Identity = { readonly dev: number; readonly ino: number };
export type KernelLockIdentity = Identity & { readonly device: string };

/** One granted FLOCK row without the ordinal: fdinfo and /proc/locks number rows independently. */
export function lockKey(
	entry: string,
	lock: KernelLockIdentity,
): { readonly owner: string; readonly value: string } | null {
	const fields = entry.trim().split(/\s+/);
	if (
		fields.length !== 8 ||
		!/^\d+:$/.test(fields[0] ?? "") ||
		fields[1] !== "FLOCK" ||
		fields[2] !== "ADVISORY" ||
		fields[3] !== "WRITE" ||
		!/^[1-9][0-9]*$/.test(fields[4] ?? "") ||
		fields[5] !== `${lock.device}:${lock.ino}` ||
		fields[6] !== "0" ||
		fields[7] !== "EOF"
	)
		return null;
	return { owner: fields[4] ?? "", value: fields.slice(1).join(" ") };
}

/** Rows on the same filesystem and inode; null when one is foreign-shaped or a waiter. */
export function lockTable(
	table: string,
	lock: KernelLockIdentity,
): Set<string> | null {
	const rows = new Set<string>();
	for (const line of table.split("\n")) {
		const inode = line
			.trim()
			.split(/\s+/)
			.find((field) => /^[0-9a-f]+:[0-9a-f]+:\d+$/.test(field));
		if (inode !== `${lock.device}:${lock.ino}`) continue;
		const key = lockKey(line, lock);
		if (!key) return null;
		rows.add(key.value);
	}
	return rows;
}

export function parentOf(stat: string): string {
	return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1] ?? "";
}

export function splitArgv(cmdline: string): string[] {
	return cmdline.split("\0").filter(Boolean);
}

export function sameArgv(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

export function equalSets(
	a: ReadonlySet<string>,
	b: ReadonlySet<string>,
): boolean {
	return a.size === b.size && [...a].every((value) => b.has(value));
}
