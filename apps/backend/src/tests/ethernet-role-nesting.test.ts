import { expect, test } from "bun:test";

import type { EthernetRole } from "@ceraui/rpc/schemas";

import {
	type EthernetRoleTransitionDeps,
	reconcileEthernetRoles,
	setEthernetRole,
} from "../modules/network/ethernet-role-transition.ts";

function harness() {
	const roles: Record<string, EthernetRole> = {};
	const applied: Record<string, string | undefined> = {};
	const deps: EthernetRoleTransitionDeps = {
		listInterfaces: () => ({ eth1: {}, eth2: {} }),
		resolveConnection: (name) => Promise.resolve(name),
		setFields: (name, fields) => {
			applied[name] = fields["ipv4.method"];
			return Promise.resolve(true);
		},
		activate: () => Promise.resolve(true),
		persistRole: (name, role) => {
			roles[name] = role;
		},
		restoreRole: (name, previous) => {
			if (previous === undefined) delete roles[name];
			else roles[name] = previous;
		},
		readPersistedRole: (name) => roles[name],
		publishOutcome: () => {},
		refreshInterfaces: () => {},
	};
	return { roles, applied, deps };
}

async function bounded<T>(operation: Promise<T>): Promise<T> {
	const deadline = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => deadline.reject(new Error("deadlock-circuit-breaker")),
		500,
	);
	try {
		return await Promise.race([operation, deadline.promise]);
	} finally {
		clearTimeout(timer);
	}
}

test("unawaited nested reconciliation rejects without overtaking the newest outside request", async () => {
	const h = harness();
	const release = Promise.withResolvers<void>();
	let nested: Promise<unknown> | undefined;
	let reads = 0;
	const deps: EthernetRoleTransitionDeps = {
		...h.deps,
		resolveConnection: async (name) => {
			reads += 1;
			if (reads === 1) {
				nested = reconcileEthernetRoles(deps, () => h.roles).then(
					() => undefined,
					(error: unknown) => error,
				);
			} else if (reads === 2) {
				await release.promise;
			}
			return name;
		},
	};

	await bounded(setEthernetRole("eth1", "shared-lan", deps));
	const outside = setEthernetRole("eth1", "uplink", deps);
	// Let any unblocked outside work finish before releasing the older read.
	// This is an event-loop turn, not a timed synchronization delay.
	await new Promise<void>((resolve) => setImmediate(resolve));
	release.resolve();
	const [outsideResult, nestedError] = await bounded(
		Promise.all([outside, nested]),
	);

	expect(outsideResult).toEqual({ success: true, applied: "uplink" });
	expect(h.roles.eth1).toBe("uplink");
	expect(h.applied.eth1).toBe("auto");
	expect(nestedError).toBeInstanceOf(Error);
	expect(nestedError).toMatchObject({
		name: "EthernetRoleReentryError",
		ownerPort: "eth1",
		requestedPort: "eth1",
	});
	expect(reads).toBe(2);
});

test("reciprocal nested calls reject while both outside owners complete", async () => {
	const h = harness();
	const both = Promise.withResolvers<void>();
	const entered = new Set<string>();
	const nestedErrors = new Map<string, unknown>();
	const deps: EthernetRoleTransitionDeps = {
		...h.deps,
		resolveConnection: async (name) => {
			if (!entered.has(name)) {
				entered.add(name);
				if (entered.size === 2) both.resolve();
				await both.promise;
				const other = name === "eth1" ? "eth2" : "eth1";
				nestedErrors.set(
					name,
					await setEthernetRole(other, "uplink", deps).then(
						() => undefined,
						(error: unknown) => error,
					),
				);
			}
			return name;
		},
	};

	const results = await bounded(
		Promise.all([
			setEthernetRole("eth1", "shared-lan", deps),
			setEthernetRole("eth2", "shared-lan", deps),
		]),
	);

	expect(results).toEqual([
		{ success: true, applied: "shared-lan" },
		{ success: true, applied: "shared-lan" },
	]);
	for (const name of ["eth1", "eth2"]) {
		const error = nestedErrors.get(name);
		expect(error).toBeInstanceOf(Error);
		expect(error).toMatchObject({
			name: "EthernetRoleReentryError",
			ownerPort: name,
			requestedPort: name === "eth1" ? "eth2" : "eth1",
		});
	}
	expect(h.roles).toEqual({ eth1: "shared-lan", eth2: "shared-lan" });
	expect(h.applied).toEqual({ eth1: "shared", eth2: "shared" });
});

test("an expired timer context queues normally behind a current owner", async () => {
	const h = harness();
	const startLate = Promise.withResolvers<void>();
	const submitted = Promise.withResolvers<void>();
	const late = Promise.withResolvers<unknown>();
	const outsideEntered = Promise.withResolvers<void>();
	const releaseOutside = Promise.withResolvers<void>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let reads = 0;
	const deps: EthernetRoleTransitionDeps = {
		...h.deps,
		resolveConnection: async (name) => {
			reads += 1;
			if (reads === 1) {
				timer = setTimeout(() => {
					void startLate.promise
						.then(() => {
							const request = setEthernetRole("eth1", "shared-lan", deps);
							submitted.resolve();
							return request;
						})
						.then(late.resolve, late.reject);
				}, 0);
			} else if (reads === 2) {
				outsideEntered.resolve();
				await releaseOutside.promise;
			}
			return name;
		},
	};
	const lateResult = late.promise.then(
		(result) => result,
		(error: unknown) => error,
	);

	try {
		await bounded(setEthernetRole("eth1", "shared-lan", deps));
		const outside = setEthernetRole("eth1", "uplink", deps);
		await bounded(outsideEntered.promise);
		startLate.resolve();
		await bounded(submitted.promise);
		const pendingRole = h.roles.eth1;
		const pendingMethod = h.applied.eth1;
		const pendingReads = reads;
		releaseOutside.resolve();
		const results = await bounded(Promise.all([outside, lateResult]));

		expect(pendingRole).toBe("uplink");
		expect(pendingMethod).toBe("shared");
		expect(pendingReads).toBe(2);
		expect(results).toEqual([
			{ success: true, applied: "uplink" },
			{ success: true, applied: "shared-lan" },
		]);
		expect(h.roles.eth1).toBe("shared-lan");
		expect(h.applied.eth1).toBe("shared");
	} finally {
		clearTimeout(timer);
		releaseOutside.resolve();
	}
});
