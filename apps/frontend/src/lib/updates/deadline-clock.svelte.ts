import { isValidCheckDeadline } from "./update-view";

const MAX_TIMEOUT_MS = 2_147_483_647;

/** One bounded timeout at a time, owned by the mounting component. */
export function createDeadlineClock(deadline: () => number | null | undefined) {
	let now = $state(Date.now());
	$effect(() => {
		const at = deadline();
		let timer: ReturnType<typeof setTimeout> | undefined;
		function refresh() {
			const current = Date.now();
			now = current;
			if (!isValidCheckDeadline(at) || at <= current) return;
			timer = setTimeout(
				refresh,
				Math.min(MAX_TIMEOUT_MS, Math.ceil(at - current)),
			);
		}
		refresh();
		return () => clearTimeout(timer);
	});
	return {
		get now() {
			return now;
		},
	};
}
