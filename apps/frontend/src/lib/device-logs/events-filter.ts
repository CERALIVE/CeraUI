import type {
	DeviceEvent,
	EventFamily,
	EventListInput,
} from "@ceraui/rpc/schemas";

export interface EventFilter {
	readonly families: readonly EventFamily[];
	readonly problemsOnly: boolean;
	readonly bootId: string | null;
}

const PAGE = 100;
const PROBLEMS = new Set(["error", "warning"]);

export function listInput(
	filter: EventFilter,
	beforeSeq: number | null,
): EventListInput & { readonly limit: number } {
	return {
		limit: PAGE,
		...(beforeSeq === null ? {} : { beforeSeq }),
		...(filter.families.length === 0 ? {} : { families: [...filter.families] }),
		...(filter.problemsOnly ? { problemsOnly: true } : {}),
		...(filter.bootId === null ? {} : { bootId: filter.bootId }),
	};
}

export function admits(filter: EventFilter, event: DeviceEvent): boolean {
	return (
		(filter.families.length === 0 || filter.families.includes(event.family)) &&
		(!filter.problemsOnly || PROBLEMS.has(event.severity)) &&
		(filter.bootId === null || filter.bootId === event.bootId)
	);
}
