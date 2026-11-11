import { expect, test } from "bun:test";

import type { EthernetRole } from "@ceraui/rpc/schemas";

import {
	EthernetRoleReentryError,
	type EthernetRoleTransitionDeps,
	reconcileEthernetRoles,
	setEthernetRole,
} from "../modules/network/ethernet-role-transition.ts";

function makeDeps(
	name: string,
	roles: Record<string, EthernetRole>,
): EthernetRoleTransitionDeps {
	return {
		listInterfaces: () => ({ [name]: {} }),
		resolveConnection: () => Promise.resolve(`uuid-${name}`),
		setFields: () => Promise.resolve(true),
		activate: () => Promise.resolve(true),
		persistRole: (ifname, role) => {
			roles[ifname] = role;
		},
		restoreRole: (ifname, previous) => {
			if (previous === undefined) delete roles[ifname];
			else roles[ifname] = previous;
		},
		readPersistedRole: (ifname) => roles[ifname],
		publishOutcome: () => {},
		refreshInterfaces: () => {},
	};
}

for (const mode of ["set", "reconcile"] as const) {
	for (const inner of ["set", "reconcile"] as const) {
		test(`awaited same-port ${inner} inside ${mode} rejects while the outer completes`, async () => {
			const name = `eth-reentry-${mode}-${inner}`;
			const roles: Record<string, EthernetRole> =
				mode === "reconcile" ? { [name]: "shared-lan" } : {};
			const nestedErrors: unknown[] = [];
			let entered = false;
			let reads = 0;
			const deps: EthernetRoleTransitionDeps = {
				...makeDeps(name, roles),
				resolveConnection: async () => {
					reads += 1;
					if (!entered) {
						entered = true;
						const nested =
							inner === "set"
								? setEthernetRole(name, "uplink", deps)
								: reconcileEthernetRoles(deps, () => roles);
						nestedErrors.push(
							await nested.then(
								() => undefined,
								(error: unknown) => error,
							),
						);
					}
					return `uuid-${name}`;
				},
			};

			const deadline = Promise.withResolvers<"deadlock-circuit-breaker">();
			const timer = setTimeout(
				() => deadline.resolve("deadlock-circuit-breaker"),
				500,
			);
			try {
				const operation =
					mode === "set"
						? setEthernetRole(name, "shared-lan", deps)
						: reconcileEthernetRoles(deps, () => roles);
				const result = await Promise.race([
					operation.then(() => "completed"),
					deadline.promise,
				]);

				expect(result).toBe("completed");
				expect(reads).toBe(1);
				expect(roles[name]).toBe("shared-lan");
				expect(nestedErrors).toHaveLength(1);
				expect(nestedErrors[0]).toBeInstanceOf(EthernetRoleReentryError);
				expect(nestedErrors[0]).toMatchObject({
					ownerPort: name,
					requestedPort: name,
				});
			} finally {
				clearTimeout(timer);
			}
		});
	}
}

test("a same-port request from an unrelated async context still waits", async () => {
	const name = "eth-external";
	const roles: Record<string, EthernetRole> = {};
	const request = Promise.withResolvers<void>();
	const submitted = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const reads: Array<EthernetRole | undefined> = [];
	const deps: EthernetRoleTransitionDeps = {
		...makeDeps(name, roles),
		resolveConnection: async () => {
			reads.push(roles[name]);
			if (reads.length === 1) {
				request.resolve();
				await release.promise;
			}
			return `uuid-${name}`;
		},
	};

	// Register this continuation outside the operation's ownership context,
	// then trigger it from within the first operation's resolver.
	const outside = request.promise.then(() => {
		const queued = setEthernetRole(name, "uplink", deps);
		submitted.resolve();
		return queued;
	});
	const first = setEthernetRole(name, "shared-lan", deps);
	await submitted.promise;
	const pendingRole = roles[name];
	const pendingReads = [...reads];
	release.resolve();
	const results = await Promise.all([first, outside]);

	expect(pendingRole).toBe("shared-lan");
	expect(pendingReads).toEqual(["shared-lan"]);
	expect(results).toEqual([
		{ success: true, applied: "shared-lan" },
		{ success: true, applied: "uplink" },
	]);
	expect(reads).toEqual(["shared-lan", "uplink"]);
	expect(roles[name]).toBe("uplink");
});
