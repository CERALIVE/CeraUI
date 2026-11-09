// @vitest-environment jsdom
import { setLocale } from "@ceraui/i18n/svelte";
import type { Notification } from "@ceraui/rpc/schemas";
import { cleanup, fireEvent, render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	clearNotifications,
	getActive,
	getPersistent,
	push,
} from "$lib/stores/notifications.svelte";
import NotificationsPanel from "$main/notifications/NotificationsPanel.svelte";
import PersistentNotices from "$main/notifications/PersistentNotices.svelte";

vi.mock("$lib/rpc", () => ({
	rpc: { notifications: { dismiss: () => Promise.resolve({}) } },
}));

function notice(overrides: Partial<Notification>): Notification {
	return {
		name: "refused",
		type: "warning",
		msg: "Wire fallback",
		is_dismissable: true,
		is_persistent: true,
		duration: 0,
		...overrides,
	};
}

beforeEach(() => {
	clearNotifications();
	setLocale("en");
});

afterEach(() => {
	cleanup();
	clearNotifications();
	setLocale("en");
	vi.restoreAllMocks();
});

describe.each([
	{
		surface: "in-flow notices",
		component: PersistentNotices,
		rowTestId: "persistent-notice",
	},
	{
		surface: "notification archive",
		component: NotificationsPanel,
		rowTestId: "notification-item",
	},
])("$surface", ({ component, rowTestId }) => {
	it("retranslates existing keyed notices and params without replacing or reordering them", async () => {
		const clock = vi.spyOn(Date, "now");
		clock.mockReturnValue(1000);
		push(
			notice({
				key: "notifications.updateRefused",
				params: { reason: "unrecognized_device_token" },
				revision: 3,
			}),
		);
		clock.mockReturnValue(2000);
		push(
			notice({
				name: "flows",
				key: "notifications.uplinkFlowsReset",
				params: { iface: "eth1" },
			}),
		);
		clock.mockReturnValue(3000);
		push(notice({ name: "literal", msg: "Literal device message" }));
		clock.mockRestore();
		const active = getActive();
		const persistent = getPersistent();
		const { getByTestId } = render(component);
		if (component === NotificationsPanel) {
			await fireEvent.click(getByTestId("notifications-bell"));
		}
		flushSync();
		const rows = () =>
			Array.from(document.querySelectorAll(`[data-testid="${rowTestId}"]`));
		const originalRows = rows();
		const texts = () =>
			rows().map((row) => row.querySelector("p")?.textContent?.trim());
		expect(texts()).toEqual([
			"Literal device message",
			"Client connections on eth1 were reset so they can move to a healthy uplink.",
			"Update refused. Check Settings → System Logs for details.",
		]);

		setLocale("es");
		flushSync();

		expect(texts()).toEqual([
			"Literal device message",
			"Se reiniciaron las conexiones de clientes en eth1 para que puedan pasar a un enlace en buen estado.",
			"Actualización rechazada. Consulta Configuración → Registros del sistema para más detalles.",
		]);
		expect(getActive()).toBe(active);
		expect(getPersistent()).toBe(persistent);
		expect(rows().map((row) => row.getAttribute("data-notification"))).toEqual([
			"literal",
			"flows",
			"refused",
		]);
		for (const [index, row] of rows().entries()) {
			expect(row).toBe(originalRows[index]);
		}
		expect(persistent.map((entry) => entry.receivedAt)).toEqual([
			3000, 2000, 1000,
		]);
	});
});
