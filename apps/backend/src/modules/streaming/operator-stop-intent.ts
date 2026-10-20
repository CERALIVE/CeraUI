let epoch = 0;

export function noteOperatorStopIntent(): void {
	epoch++;
}

export function captureOperatorStopIntent(): () => boolean {
	const captured = epoch;
	return () => epoch === captured;
}
