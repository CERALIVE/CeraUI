import type { UpdateProgress } from './schemas/system.schema';

const phaseRank = (p: UpdateProgress) =>
	p.setting_up > 0 || p.unpacking > 0 ? 2 : p.downloading > 0 ? 1 : 0;

/**
 * What a running transaction shows: its phase never moves back and, within a
 * phase, neither does APT's number. A result or a new run shows what arrived.
 * Returns `previous` itself when `next` does not advance it.
 */
export function holdUpdateProgress<T extends UpdateProgress>(previous: T | undefined, next: T): T {
	if (!previous || previous.result !== undefined || next.result !== undefined) return next;
	const before = phaseRank(previous);
	const after = phaseRank(next);
	if (after !== before) return after > before ? next : previous;
	return (next.percent ?? -1) > (previous.percent ?? -1) ? next : previous;
}
