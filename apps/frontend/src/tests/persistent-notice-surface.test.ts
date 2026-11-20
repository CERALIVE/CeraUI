// @vitest-environment jsdom
/**
 * A PERSISTENT NOTIFICATION IS NOT A TOAST.
 *
 * `LayoutToastHost` used to hand every active notification to svelte-sonner and
 * give the persistent ones `duration: Number.POSITIVE_INFINITY` — a permanent
 * card on an overlay layer at z-index 999999999. Board-measured on `ceralive2`
 * (task 41's fleet drill) that card owned the fixed mobile dock's hit-test point
 * at 375x812 and 768x900, and covered every AppDialog's primary action at
 * 1024x600. Nothing recovers a toast with no expiry.
 *
 * These are the unit halves of that contract. `tests/e2e/notification-overlap.spec.ts`
 * is the geometry half — only a real browser can measure a stacking layer.
 */
import type { Notification } from "@ceraui/rpc/schemas";
import { fireEvent, render, within } from "@testing-library/svelte";
import * as Svelte from "svelte";
import { flushSync, type Snippet } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type ToastAction = { label: string; onClick: () => void };
const toastCalls: {
	level: string;
	text: string | Snippet;
	duration: unknown;
	action?: ToastAction;
	cancel?: Snippet;
	class?: string;
}[] = [];
const dismissed: (string | undefined)[] = [];

vi.mock("svelte-sonner", () => {
	const record =
		(level: string) =>
		(
			text: string | Snippet,
			options?: {
				duration?: unknown;
				action?: ToastAction;
				cancel?: Snippet;
				class?: string;
			},
		): string => {
			toastCalls.push({
				level,
				text,
				duration: options?.duration,
				action: options?.action,
				cancel: options?.cancel,
				class: options?.class,
			});
			return "mock-toast";
		};
	const toast = Object.assign(record("default"), {
		success: record("success"),
		error: record("error"),
		warning: record("warning"),
		info: record("info"),
		dismiss: (id?: string) => {
			dismissed.push(id);
		},
	});
	return { toast };
});

vi.mock("$lib/components/ui/sonner", async () => ({
	Toaster: (await import("./fixtures/ToasterStub.svelte")).default,
}));

vi.mock("$lib/helpers/SystemHelper", () => ({
	startStreaming: () => undefined,
	stopStreaming: () => undefined,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { notifications: { dismiss: () => Promise.resolve({}) } },
}));

vi.mock("$lib/stores/navigation-lazy", () => ({
	navigateToDestination: () => undefined,
}));

import { VIEW_LOGS_TOAST_CLASS } from "$lib/device-logs/view-logs";
import {
	clearRequestedDialog,
	getRequestedDialog,
	getRequestedDialogContext,
} from "$lib/stores/dialog-request.svelte";
import {
	clearNotifications,
	getPersistent,
	push,
} from "$lib/stores/notifications.svelte";
import LayoutToastHost from "$main/layout/LayoutToastHost.svelte";
import NotificationsPanel from "$main/notifications/NotificationsPanel.svelte";
import PersistentNotices from "$main/notifications/PersistentNotices.svelte";
import LogActionSnippetHarness from "./fixtures/LogActionSnippetHarness.svelte";
import { readToasterProps } from "./fixtures/ToasterStub.svelte";
import { en } from "./helpers/catalog";

const DUP_IP_TEXT =
	"Interfaces enx0c5b8f279a64, eth1 share the same IP address: 192.168.8.100.";

function notification(overrides: Partial<Notification> = {}): Notification {
	return {
		name: "netif_dup_ip",
		type: "warning",
		msg: DUP_IP_TEXT,
		duration: 0,
		is_persistent: true,
		is_dismissable: true,
		...overrides,
	} as Notification;
}

beforeEach(() => {
	toastCalls.length = 0;
	dismissed.length = 0;
	clearNotifications();
	window.matchMedia ??= ((query: string) => ({
		matches: false,
		media: query,
		addEventListener: () => undefined,
		removeEventListener: () => undefined,
		addListener: () => undefined,
		removeListener: () => undefined,
		onchange: null,
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
});

afterEach(() => {
	clearNotifications();
	clearRequestedDialog();
	vi.restoreAllMocks();
});

/** Push with a fixed `receivedAt`, which is the moment View logs opens at. */
function pushAt(at: number, overrides: Partial<Notification>): void {
	const clock = vi.spyOn(Date, "now").mockReturnValue(at);
	push(notification(overrides));
	clock.mockRestore();
}

const START_FAILED = "notifications.streamStartInternalFailed";
const REFUSED_WITH_ACTION: Partial<Notification> = {
	name: "update:refused:1",
	key: "notifications.updateRefused",
	params: { reason: "apt: E: Sub-process returned an error code" },
	action: {
		schema: 1,
		kind: "navigate",
		target: "updates-dialog",
		labelKey: "notifications.openUpdates",
	},
};

describe("LayoutToastHost — the toast layer is transient only", () => {
	it("never toasts a persistent notification", () => {
		push(notification());
		render(LayoutToastHost);
		flushSync();

		expect(toastCalls).toEqual([]);
	});

	it("still toasts a transient notification, with its own duration", () => {
		push(notification({ name: "fleeting", is_persistent: false, duration: 3 }));
		render(LayoutToastHost);
		flushSync();

		expect(toastCalls).toHaveLength(1);
		expect(toastCalls[0]?.level).toBe("warning");
		expect(toastCalls[0]?.duration).toBe(3000);
	});

	it("never hands sonner an infinite duration", () => {
		push(notification());
		push(notification({ name: "fleeting", is_persistent: false, duration: 3 }));
		render(LayoutToastHost);
		flushSync();

		for (const call of toastCalls) {
			expect(call.duration).not.toBe(Number.POSITIVE_INFINITY);
		}
	});

	it("clears the mobile dock: the toast stack is offset above it", () => {
		render(LayoutToastHost);
		flushSync();

		// jsdom's stubbed matchMedia answers `matches: false` for the desktop-chrome
		// query, i.e. the MOBILE layout — the one that mounts the fixed dock.
		const props = readToasterProps();
		const offset = props.offset as { bottom?: string } | undefined;
		expect(offset?.bottom).toContain("--mobile-dock-height");
		expect(props.mobileOffset).toEqual(props.offset);
	});

	it("clears the Live bar: the toast stack is offset above it too", () => {
		render(LayoutToastHost);
		flushSync();

		const offset = readToasterProps().offset as { bottom?: string } | undefined;
		expect(offset?.bottom).toContain("--live-bar-height");
	});
});

describe("LayoutToastHost: View logs on a log-pointing toast", () => {
	it("adds View logs to a transient toast that points to System Logs, at its arrival", () => {
		pushAt(4242, {
			name: "start",
			key: START_FAILED,
			is_persistent: false,
			duration: 5,
		});
		render(LayoutToastHost);
		flushSync();

		const action = toastCalls[0]?.action;
		expect(action?.label).toBe(en.notifications.viewLogs);
		action?.onClick();
		expect(getRequestedDialog()).toBe("logs");
		expect(getRequestedDialogContext()).toEqual({ tab: "raw", at: 4242 });
	});

	it("reads a transient refusal by its reason sentence, which points to the logs", () => {
		pushAt(77, {
			name: "refused-toast",
			key: "notifications.updateRefused",
			params: { reason: "dpkg lock held" },
			is_persistent: false,
			duration: 3,
		});
		render(LayoutToastHost);
		flushSync();

		expect(toastCalls[0]?.action?.label).toBe(en.notifications.viewLogs);
	});

	it("renders the complete translated log message through the CJK snippet and releases its own mount", async () => {
		pushAt(8000, {
			name: "copy-witness",
			key: START_FAILED,
			is_persistent: false,
			duration: 3,
		});
		render(LayoutToastHost);
		flushSync();
		const content = toastCalls[0]?.text;
		if (typeof content !== "function")
			throw new Error("Log message was not a live snippet");
		const mounted = vi.spyOn(Svelte, "mount");
		const unmounted = vi.spyOn(Svelte, "unmount");
		const view = render(LogActionSnippetHarness, { content });
		flushSync();
		expect(view.container.textContent).toBe(
			en.notifications.streamStartInternalFailed,
		);
		const instance = mounted.mock.results.at(-1)?.value;

		await view.unmount();
		expect(unmounted.mock.calls.some(([value]) => value === instance)).toBe(
			true,
		);
	});

	it("adds nothing to a toast that does not point to the logs", () => {
		push(
			notification({
				name: "saved",
				key: "notifications.saved",
				is_persistent: false,
				duration: 3,
			}),
		);
		render(LayoutToastHost);
		flushSync();

		expect(toastCalls).toHaveLength(1);
		expect(toastCalls[0]?.action).toBeUndefined();
		expect(typeof toastCalls[0]?.text).toBe("string");
	});

	it("keeps a toast's own navigate action", () => {
		push(
			notification({
				...REFUSED_WITH_ACTION,
				is_persistent: false,
				duration: 3,
			}),
		);
		render(LayoutToastHost);
		flushSync();

		const action = toastCalls[0]?.action;
		expect(action?.label).toBe(en.notifications.openUpdates);
		action?.onClick();
		expect(getRequestedDialog()).toBe("updates-dialog");
		expect(dismissed).toEqual(["update:refused:1"]);
		expect(typeof toastCalls[0]?.cancel).toBe("function");
	});

	it.each([true, false])(
		"offers View logs beside navigation even when dismissable=%s",
		async (is_dismissable) => {
			pushAt(8000, {
				...REFUSED_WITH_ACTION,
				key: START_FAILED,
				is_persistent: false,
				is_dismissable,
				duration: 3,
			});
			render(LayoutToastHost);
			flushSync();

			expect(toastCalls[0]?.action?.label).toBe(en.notifications.openUpdates);
			expect(toastCalls[0]?.class).toBe(VIEW_LOGS_TOAST_CLASS);
			const content = toastCalls[0]?.cancel;
			const mounted = vi.spyOn(Svelte, "mount");
			const unmounted = vi.spyOn(Svelte, "unmount");
			const view = render(LogActionSnippetHarness, { content });
			const logs = await view.findByRole("button", {
				name: en.notifications.viewLogs,
			});
			const actionInstance = mounted.mock.results.at(-1)?.value;
			expect(actionInstance).toBeDefined();
			await fireEvent.click(logs);
			expect(getRequestedDialog()).toBe("logs");
			expect(getRequestedDialogContext()).toEqual({ tab: "raw", at: 8000 });
			expect(dismissed).toEqual(["update:refused:1"]);
			await view.unmount();
			expect(
				unmounted.mock.calls.some(([instance]) => instance === actionInstance),
			).toBe(true);
		},
	);

	it("keeps navigation alone when the toast does not point to the logs", () => {
		push(
			notification({
				...REFUSED_WITH_ACTION,
				key: "notifications.saved",
				is_persistent: false,
				duration: 3,
			}),
		);
		render(LayoutToastHost);
		flushSync();

		expect(toastCalls[0]?.action?.label).toBe(en.notifications.openUpdates);
		expect(toastCalls[0]?.cancel).toBeUndefined();
		expect(toastCalls[0]?.class).toBeUndefined();
	});
});

describe.each([
	{
		surface: "PersistentNotices",
		component: PersistentNotices,
		row: "persistent-notice",
		navigate: "persistent-notice-action",
	},
	{
		surface: "NotificationsPanel",
		component: NotificationsPanel,
		row: "notification-item",
		navigate: "notification-action",
	},
])(
	"$surface: View logs beside a log-pointing notice",
	({ component, row, navigate }) => {
		async function mount(): Promise<HTMLElement> {
			const view = render(component);
			if (component === NotificationsPanel) {
				await fireEvent.click(view.getByTestId("notifications-bell"));
			}
			flushSync();
			const [first] = document.querySelectorAll<HTMLElement>(
				`[data-testid="${row}"]`,
			);
			if (!first) throw new Error(`no ${row} rendered`);
			return first;
		}

		it("opens System Logs on Raw logs at the notice's arrival", async () => {
			pushAt(1000, { key: START_FAILED });
			const notice = await mount();

			const action = within(notice).getByTestId("view-logs-action");
			expect(action.textContent?.trim()).toBe(en.notifications.viewLogs);
			expect(action.className).toContain("h-7");
			expect(action.className).toContain("text-xs");
			await fireEvent.click(action);

			expect(getRequestedDialog()).toBe("logs");
			expect(getRequestedDialogContext()).toEqual({ tab: "raw", at: 1000 });
		});

		it("shows no View logs beside a notice that does not point to the logs", async () => {
			push(
				notification({
					key: "notifications.uplinkFlowsReset",
					params: { iface: "eth1" },
				}),
			);
			const notice = await mount();

			expect(within(notice).queryByTestId("view-logs-action")).toBeNull();
		});

		it("offers View logs next to a refusal's own action, a finger's width apart", async () => {
			push(notification(REFUSED_WITH_ACTION));
			const notice = await mount();

			expect(within(notice).getByTestId(navigate).className).toContain("me-2");
			expect(within(notice).getByTestId("view-logs-action")).toBeTruthy();
		});
	},
);

describe("NotificationsPanel: View logs leaves the archive", () => {
	it("closes the panel so System Logs is not opened behind it", async () => {
		push(notification({ key: START_FAILED }));
		const view = render(NotificationsPanel);
		await fireEvent.click(view.getByTestId("notifications-bell"));
		flushSync();

		await fireEvent.click(view.getByTestId("view-logs-action"));

		await expect
			.poll(() => view.queryByTestId("notifications-list"))
			.toBeNull();
	});
});

describe("PersistentNotices — the in-flow home for a notice with no expiry", () => {
	it("renders the warning text, so nothing is hidden", () => {
		push(notification());
		const { container } = render(PersistentNotices);
		flushSync();

		const notice = container.querySelector('[data-testid="persistent-notice"]');
		expect(notice?.textContent).toContain(DUP_IP_TEXT);
		expect(notice?.getAttribute("data-notification")).toBe("netif_dup_ip");
		expect(notice?.getAttribute("data-notification-type")).toBe("warning");
	});

	it("is on NO stacking layer — it can push content down, never cover it", () => {
		push(notification());
		const { container } = render(PersistentNotices);
		flushSync();

		// The occlusion this replaced was a `position: fixed` card at z-index
		// 999999999; a band that acquired either would reintroduce it.
		for (const el of container.querySelectorAll("*")) {
			const className = el.getAttribute("class") ?? "";
			expect(className).not.toMatch(/(^|\s)fixed(\s|$)/);
			expect(className).not.toMatch(/(^|\s)z-\[?\d/);
		}
	});

	it("renders nothing for a transient notification", () => {
		push(notification({ name: "fleeting", is_persistent: false, duration: 3 }));
		const { container } = render(PersistentNotices);
		flushSync();

		expect(
			container.querySelector('[data-testid="persistent-notices"]'),
		).toBeNull();
	});

	it("renders nothing at all when there is no persistent notice", () => {
		const { container } = render(PersistentNotices);
		flushSync();

		expect(
			container.querySelector('[data-testid="persistent-notice"]'),
		).toBeNull();
	});

	it("offers a dismiss that drops the notice from the store", async () => {
		push(notification());
		const { container } = render(PersistentNotices);
		flushSync();

		const dismiss = container.querySelector<HTMLButtonElement>(
			'[data-testid="persistent-notice-dismiss"]',
		);
		expect(dismiss).not.toBeNull();
		dismiss?.click();
		await Promise.resolve();
		flushSync();

		expect(getPersistent()).toHaveLength(0);
	});

	it("withholds the dismiss control for a notice the device will not let go", () => {
		push(notification({ name: "bootconfig", is_dismissable: false }));
		const { container } = render(PersistentNotices);
		flushSync();

		expect(
			container.querySelector('[data-testid="persistent-notice-dismiss"]'),
		).toBeNull();
		expect(
			container.querySelector('[data-testid="persistent-notice"]')?.textContent,
		).toContain(DUP_IP_TEXT);
	});
});
