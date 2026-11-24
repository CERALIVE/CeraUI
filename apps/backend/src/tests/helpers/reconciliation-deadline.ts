/** Drive a deliberately silent reconciliation once its production timer is armed. */
export function manualReconciliationDeadline() {
	const scheduled = Promise.withResolvers<() => void>();
	let expiring = false;
	return {
		scheduleTimeout(callback: () => void) {
			// Supply a real timer handle without letting wall time drive the test.
			const timer = setTimeout(callback, 0);
			clearTimeout(timer);
			if (expiring) scheduled.resolve(callback);
			return timer;
		},
		async expireDuring<T>(start: () => Promise<T>): Promise<T> {
			expiring = true;
			const result = start();
			// A regression that settles without probing must reach the assertions.
			return Promise.race([
				result,
				scheduled.promise.then((expire) => {
					expire();
					return result;
				}),
			]);
		},
	};
}
