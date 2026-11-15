export function scanBudget(
	limits: {
		readonly deadlineMs: number;
		readonly records: number;
		readonly stdoutBytes: number;
	},
	clock: { now(): number },
) {
	const started = clock.now();
	let candidates = 0;
	let total = 0;

	return {
		delay() {
			return Math.max(0, limits.deadlineMs - (clock.now() - started));
		},
		exhausted() {
			return (
				candidates >= limits.records ||
				clock.now() - started >= limits.deadlineMs
			);
		},
		take() {
			candidates++;
		},
		overStdout(bytes: number) {
			total += bytes;
			return total > limits.stdoutBytes;
		},
	};
}
