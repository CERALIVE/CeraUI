/**
 * What an Events row says about one device event, in the active locale. A known
 * code whose params pass its registry schema gets its title and one detail
 * sentence; a known code with invalid params keeps its title alone; a code from
 * a newer version gets the honest generic title and its family icon. Raw tokens
 * the sentences never show (and an unknown code itself) go only to the row's
 * collapsed Diagnostics disclosure (DESIGN.md OL-3..OL-5).
 */
import { formatRelativeTime } from "@ceraui/i18n/formatters";
import { getLocale, m, t } from "@ceraui/i18n/svelte";
import {
	EVENT_REGISTRY,
	type EventCode,
	type EventParams,
} from "@ceraui/rpc/events";
import type {
	DeviceEvent,
	EventFamily,
	EventSeverity,
} from "@ceraui/rpc/schemas";
import {
	Cpu,
	Download,
	Network,
	Radio,
	SignalHigh,
	Video,
} from "@lucide/svelte";
import type { Component } from "svelte";

import { NOTIFICATION_ICONS } from "$main/notifications/notification-presentation";

import { formatBootTime } from "./boot-rows";
import {
	DETAILS,
	DIAGNOSTIC_PARAMS,
	type Names,
	type Sentence,
} from "./timeline-details";

/** One piece of a detail sentence; a data param renders inside a <bdi>. */
export interface DetailPart {
	readonly text: string;
	readonly param: boolean;
}

export interface EventGlyph {
	readonly icon: Component;
	readonly tone: string;
	readonly label: string;
}

export interface EventDiagnostics {
	readonly code: string;
	readonly values: readonly (readonly [string, string])[];
}

export interface EventCopy {
	readonly title: string;
	readonly detail: readonly DetailPart[] | null;
	readonly glyph: EventGlyph;
	readonly diagnostics: EventDiagnostics | null;
}

const SEVERITY_TONE: Record<EventSeverity, string> = {
	error: "text-status-error",
	warning: "text-status-warning",
	info: "text-muted-foreground",
	success: "text-status-success",
};

const FAMILY_ICONS: Record<EventFamily, Component> = {
	stream: Radio,
	network: Network,
	cellular: SignalHigh,
	update: Download,
	device: Cpu,
	capture: Video,
};

// Every enum value the registry accepts has copy (timeline-copy-completeness.test.ts),
// and a newer device's value fails this registry's schema, so every key exists.
const MARK = "\u0000";

function parts({ key, values = {} }: Sentence): DetailPart[] {
	const marked = Object.fromEntries(
		Object.entries(values).map(([name, value]) => [
			name,
			`${MARK}${value.replaceAll(MARK, "\uFFFD")}${MARK}`,
		]),
	);
	return t(key, marked)
		.split(MARK)
		.flatMap((text, index): DetailPart[] =>
			index % 2 === 1
				? [{ text, param: true }]
				: text === ""
					? []
					: [{ text, param: false }],
		);
}

function isEventCode(code: string): code is EventCode {
	return Object.hasOwn(EVENT_REGISTRY, code);
}

function known<C extends EventCode>(
	code: C,
	event: DeviceEvent,
	names: Names,
): Pick<EventCopy, "detail" | "diagnostics"> {
	const parsed = EVENT_REGISTRY[code].params.safeParse(event.params);
	if (!parsed.success)
		return { detail: null, diagnostics: { code, values: [] } };
	// TypeScript widens a generic registry index to every schema; this one is C's own.
	const sentence =
		DETAILS[code]?.(parsed.data as EventParams<C>, getLocale(), names) ?? null;
	const data: Readonly<Record<string, unknown>> = parsed.data;
	const values = (DIAGNOSTIC_PARAMS[code] ?? []).flatMap((name) => {
		const value = data[name];
		if (value === undefined) return [];
		return [
			[name, Array.isArray(value) ? value.join(", ") : String(value)] as const,
		];
	});
	return {
		detail: sentence === null ? null : parts(sentence),
		diagnostics: values.length === 0 ? null : { code, values },
	};
}

export function eventCopy(
	event: DeviceEvent,
	names: Names = new Map(),
): EventCopy {
	const { code, family, severity } = event;
	if (!isEventCode(code)) {
		return {
			title: m["timeline.unknown.title"](),
			detail: parts({ key: "timeline.unknown.detail" }),
			glyph: {
				icon: FAMILY_ICONS[family],
				tone: "text-muted-foreground",
				label: m[`timeline.family.${family}`](),
			},
			diagnostics: { code, values: [] },
		};
	}
	return {
		title: m[`timeline.${code}.title`](),
		glyph: {
			icon: NOTIFICATION_ICONS[severity],
			tone: SEVERITY_TONE[severity],
			label: m[`systemLogs.severity.${severity}`](),
		},
		...known(code, event, names),
	};
}

export function eventTime(
	at: number,
	locale: string,
): {
	readonly iso: string;
	readonly absolute: string;
	readonly relative: string;
} {
	const today = new Date(at).toDateString() === new Date().toDateString();
	return {
		iso: new Date(at).toISOString(),
		absolute: today
			? new Intl.DateTimeFormat(locale, { timeStyle: "medium" }).format(at)
			: formatBootTime(at, locale),
		relative: formatRelativeTime(locale)(new Date(at)),
	};
}
