import assert from "node:assert/strict";

export type ExpectedAp = { ifname: string; uuid: string; ssid: string };

export function assertActiveApPair(active: string, pair: readonly [ExpectedAp, ExpectedAp]) {
	const connections = new Set(active.split("\n"));
	assert.notEqual(pair[0].uuid, pair[1].uuid, "The APs must use different profiles");
	for (const { ifname, uuid } of pair) {
		assert(
			connections.has(`${uuid}:${ifname}`),
			`${ifname} is missing its AP from the active NM snapshot`,
		);
	}
}

export async function waitForSettledPublication(
	refresh: () => Promise<unknown>,
	subscribe: (listener: () => void) => () => void,
	settled: () => Promise<void> | undefined,
	ready: () => boolean,
	timeoutDetails: () => string,
) {
	let changed = Promise.withResolvers<void>();
	const unsubscribe = subscribe(() => changed.resolve());
	const deadline = Promise.withResolvers<false>();
	const timer = setTimeout(() => deadline.resolve(false), 20_000);
	const withinDeadline = async (pending: Promise<unknown>) => {
		if (!(await Promise.race([pending.then(() => true), deadline.promise]))) {
			throw new Error(`Timed out waiting for published guest Wi-Fi rows: ${timeoutDetails()}`);
		}
	};
	try {
		await withinDeadline(refresh());
		for (;;) {
			const pending = settled();
			if (pending) {
				await withinDeadline(pending);
				continue;
			}
			// Publication can fire before the sample settles; only the current state counts.
			if (ready()) return;
			await withinDeadline(changed.promise);
			changed = Promise.withResolvers<void>();
		}
	} finally {
		clearTimeout(timer);
		unsubscribe();
	}
}
