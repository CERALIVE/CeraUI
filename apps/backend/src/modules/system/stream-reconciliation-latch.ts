// The stream factory starts with an idle projection before any engine has been
// asked. Until boot reconciliation has returned, that projection is not
// evidence, so the latch starts closed. Dependency-free so the test preload can
// model a booted backend without loading the streaming graph.
let completed = false;

export function noteStreamReconciliationCompleted(): void {
	completed = true;
}

export function isStreamReconciliationCompleted(): boolean {
	return completed;
}

export function setStreamReconciliationCompletedForTest(value: boolean): void {
	completed = value;
}
