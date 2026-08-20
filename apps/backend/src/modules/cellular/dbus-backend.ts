/*
    CeraUI - web UI for the CeraLive project
    Copyright (C) 2024-2025 CeraLive project

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.
    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

/**
 * The `dbus` cellular backend: the adapter that turns the
 * `@ceralive/modem-control` epoch-scoped ModemManager observer into the modem
 * EVENT SOURCE beneath the existing wire producer.
 *
 * Every call it can make crosses {@link createAuditingDbusTransport} first, so the
 * read-only guarantee is enforced by the transport rather than trusted of the
 * observer. This module is imported LAZILY by `cellular-stack.ts` and only when
 * the D-Bus backend is selected, so an mmcli-rollback device never loads the
 * D-Bus client at all.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE STARTUP CANCELLATION CONTRACT — the part that is easy to lose
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * `cellular-stack.ts`'s `withDeadline(backend.start())` CANNOT cancel the
 * underlying start: the race loses, the work continues. `MmDbusObserver.start()`
 * has no stopped-generation checks between connect / subscribe / owner-lookup /
 * snapshot either. So a timed-out start can resolve minutes later, in a process
 * that has already fallen back to mmcli.
 *
 * This backend therefore owns its own generation: {@link CellularBackend.stop}
 * sets `aborted` SYNCHRONOUSLY, every observer callback is generation-checked,
 * and a `start()` that resolves after the abort tears itself down instead of
 * writing to the cache. Zero late cache writes, zero late authority changes,
 * zero surviving subscriptions. Contract: `docs/DBUS-OBSERVATION-CONTRACT.md`.
 */

import { createMmDbusObserver } from "@ceralive/modem-control";
import {
	createDbusTransport,
	type DbusTransport,
	type SignalListener,
	type SignalSpec,
	type Subscription,
} from "@ceralive/modem-control/transport";

import { logger } from "../../helpers/logger.ts";

import type { CellularBackend, CellularStartResult } from "./cellular-stack.ts";
import { createAuditingDbusTransport } from "./dbus-audit-transport.ts";
import { type DbusModemCache, getDbusModemCache } from "./dbus-modem-cache.ts";
import { foldDbusModemViews } from "./dbus-view-fold.ts";

const SYSTEM_BUS_ADDRESS = "unix:path=/var/run/dbus/system_bus_socket";

export function resolveSystemBusAddress(
	env: Record<string, string | undefined> = process.env,
): string {
	const configured = env.DBUS_SYSTEM_BUS_ADDRESS?.trim();
	return configured !== undefined && configured.length > 0
		? configured
		: SYSTEM_BUS_ADDRESS;
}

const NO_OP_SUBSCRIPTION: Subscription = {
	unsubscribe: async (): Promise<void> => undefined,
};

/**
 * An aborted generation subscribes to NOTHING.
 *
 * `MmDbusObserver.stop()` is IDEMPOTENT — once stopped it returns early — so
 * the four match rules a late-resolving `start()` re-issues afterwards are
 * never torn down by the observer and would leak onto the bus for the process
 * lifetime. Refusing them at `subscribeSignal` is the only place that can see
 * them, because the observer creates them itself and hands us no handle.
 */
function refuseSubscriptionsOnceAborted(
	inner: DbusTransport,
	isAborted: () => boolean,
): DbusTransport {
	return {
		...inner,
		async subscribeSignal(
			spec: SignalSpec,
			listener: SignalListener,
		): Promise<Subscription> {
			const subscription = await inner.subscribeSignal(spec, listener);
			if (!isAborted()) {
				return subscription;
			}
			await subscription.unsubscribe().catch(() => undefined);
			return NO_OP_SUBSCRIPTION;
		},
	};
}

export interface DbusCellularBackendDeps {
	readonly cache?: DbusModemCache;
	/** Test seam (the `set*Runner` convention): substitute the bus, not the audit. */
	readonly transport?: DbusTransport;
}

export function createDbusCellularBackend(
	deps: DbusCellularBackendDeps = {},
): CellularBackend {
	const cache = deps.cache ?? getDbusModemCache();
	const audited = createAuditingDbusTransport(
		deps.transport ??
			createDbusTransport({ busAddress: resolveSystemBusAddress() }),
	);

	let aborted = false;

	const observer = createMmDbusObserver({
		transport: refuseSubscriptionsOnceAborted(audited, () => aborted),
		onEpochRefresh: ({ epoch, tree }) => {
			if (aborted) {
				return;
			}
			cache.applySnapshot(epoch, foldDbusModemViews(tree));
		},
	});

	// Subscribed BEFORE `start()` so a failure raised while priming — the very
	// window `withDeadline` is racing — still reaches the cache's failure classes.
	const unobserve = observer.observe((list) => {
		if (aborted || list.ok) {
			return;
		}
		cache.applyFailure(list.reason);
	});

	async function teardown(): Promise<void> {
		unobserve();
		await observer.stop().catch(() => undefined);
		await audited.disconnect().catch(() => undefined);
	}

	return {
		async start(): Promise<CellularStartResult> {
			if (aborted) {
				return { ok: false };
			}
			const list = await observer.start();
			if (aborted) {
				logger.debug(
					"cellular dbus backend: start resolved after abort; discarding",
				);
				await teardown();
				return { ok: false };
			}
			return { ok: list.ok };
		},
		async stop(): Promise<void> {
			aborted = true;
			cache.reset();
			await teardown();
		},
	};
}
