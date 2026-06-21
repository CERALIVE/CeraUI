/**
 * Low-disk warning — derived from the EXISTING device-stats `disk` signal.
 *
 * This is NOT a sixth device-stats field. It is a pure derivation over the
 * `disk` signal the backend already broadcasts (S1 lock: used/total bytes on
 * `/data`). When the free space on `/data` drops below a FIXED 512 MiB floor the
 * UI surfaces a calm banner — recording, logs, and OTA staging all need headroom.
 *
 * The threshold is deliberately fixed (not operator-configurable): it is a
 * production-readiness floor, not a tunable.
 */

/** Free-space floor for the low-disk warning: 512 MiB, in bytes. */
export const LOW_DISK_THRESHOLD_BYTES = 512 * 1024 * 1024;

/** The subset of the device-stats `disk` signal this derivation reads. */
export interface DiskUsageLike {
	/** Bytes used on `/data`. */
	used: number;
	/** Total bytes on `/data`. */
	total: number;
}

/**
 * True when `/data` has less than {@link LOW_DISK_THRESHOLD_BYTES} free.
 *
 * Returns `false` for a missing/unparseable disk signal — a degraded source
 * never raises a false alarm. The boundary is strict `<`: exactly 512 MiB free
 * does NOT warn; 511 MiB does.
 */
export function isDiskLow(disk: DiskUsageLike | null | undefined): boolean {
	if (disk == null) return false;
	const free = disk.total - disk.used;
	if (!Number.isFinite(free)) return false;
	return free < LOW_DISK_THRESHOLD_BYTES;
}
