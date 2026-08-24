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
import { render } from "@testing-library/svelte";
import { flushSync } from "svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toastCalls: { level: string; text: string; duration: unknown }[] = [];
const dismissed: (string | undefined)[] = [];

vi.mock("svelte-sonner", () => {
	const record =
		(level: string) =>
		(text: string, options?: { duration?: unknown }): string => {
			toastCalls.push({ level, text, duration: options?.duration });
			return text;
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

vi.mock("$lib/stores/connection-ux.svelte", () => ({
	deriveConnectionSurfaceUx: () => ({ showConnectionLostToast: false }),
	getDisconnectedSince: () => undefined,
	getGraceNow: () => 0,
}));

vi.mock("$lib/rpc", () => ({
	rpc: { notifications: { dismiss: () => Promise.resolve({}) } },
}));

import {
	clearNotifications,
	getPersistent,
	push,
} from "$lib/stores/notifications.svelte";
import LayoutToastHost from "$main/layout/LayoutToastHost.svelte";
import PersistentNotices from "$main/notifications/PersistentNotices.svelte";
import { readToasterProps } from "./fixtures/ToasterStub.svelte";

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
});

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
