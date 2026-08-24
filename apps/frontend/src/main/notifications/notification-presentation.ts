/**
 * Shared vocabulary for the TWO persistent-notification surfaces.
 *
 * A persistent notification is rendered twice by design — once in flow by
 * `PersistentNotices.svelte` (so the operator meets it on arrival) and once in
 * `NotificationsPanel.svelte` (the bell's archive, with the same per-item
 * dismiss). The two are deliberately different SHAPES, but they must not become
 * different VOCABULARIES: a warning that draws a triangle in one place and a
 * circle in the other is the drift this module exists to prevent.
 *
 * Icons are shared; the tone CLASSES are not, because the two live on different
 * surfaces (the panel's rows sit on `bg-card` inside a dialog, the band sits in
 * the page's own flow) and the panel's existing treatment is unchanged by this
 * module's introduction.
 */
import type { NotificationType } from "@ceraui/rpc/schemas";
import CircleAlert from "@lucide/svelte/icons/circle-alert";
import CircleCheck from "@lucide/svelte/icons/circle-check";
import Info from "@lucide/svelte/icons/info";
import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
import type { Component } from "svelte";

import { rpc } from "$lib/rpc";
import { dismiss } from "$lib/stores/notifications.svelte";

/** One glyph per severity, shared by the band and the panel. */
export const NOTIFICATION_ICONS: Record<NotificationType, Component> = {
	success: CircleCheck,
	warning: TriangleAlert,
	error: CircleAlert,
	info: Info,
};

/** The in-flow band's own frame: a calm tinted surface, never a scrim. */
export const NOTIFICATION_BAND_CLASS: Record<NotificationType, string> = {
	success: "border-status-success/30 bg-status-success/10",
	warning: "border-status-warning/30 bg-status-warning/10",
	error: "border-status-error/30 bg-status-error/10",
	info: "border-status-info/30 bg-status-info/10",
};

/** The band's glyph colour — reinforcement only; every band prints its text. */
export const NOTIFICATION_BAND_ICON_CLASS: Record<NotificationType, string> = {
	success: "text-status-success",
	warning: "text-status-warning",
	error: "text-status-error",
	info: "text-status-info",
};

/**
 * Drop a persistent notification from both surfaces.
 *
 * The local removal is the source of truth for what is on screen; the backend
 * call is best-effort, and a server-side remove broadcast (if any) reconciles
 * idempotently through `subscriptions.svelte`.
 */
export async function dismissPersistentNotification(
	name: string,
): Promise<void> {
	dismiss(name);
	try {
		await rpc.notifications.dismiss({ name });
	} catch {
		/* best-effort: the optimistic local removal above already happened. */
	}
}
