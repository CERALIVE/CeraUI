// Local device detection + private job reads normally take milliseconds. Ten
// seconds allows loaded storage headroom while staying well inside a 45s client
// timeout. This bounds observation only, never a writer or its guardian.
export const UPDATE_ADMISSION_DEADLINE_MS = 10_000;

type DeadlineTimer = (expire: () => void, ms: number) => () => void;
const defaultTimer: DeadlineTimer = (expire, ms) => {
	const timer = setTimeout(expire, ms);
	return () => clearTimeout(timer);
};
let timer: DeadlineTimer = defaultTimer;

export function setUpdateAdmissionDeadlineTimerForTest(
	replacement: DeadlineTimer | null,
): void {
	timer = replacement ?? defaultTimer;
}

export function armUpdateAdmissionDeadline(expire: () => void): () => void {
	return timer(expire, UPDATE_ADMISSION_DEADLINE_MS);
}
