import type {
	DeviceEvent,
	LogAroundInput,
	LogAroundOutput,
} from "@ceraui/rpc/schemas";

export type AroundPage = Extract<LogAroundOutput, { ok: true }>;
export type RawLinkState = "pending" | "removed" | "busy" | "failed";

export class EventsRawLink {
	#link = $state.raw<{
		readonly id: string;
		readonly state: RawLinkState;
	} | null>(null);
	#request: object | undefined;
	// The newest request's `since()`: a boot pick after the press supersedes it.
	#still: () => boolean = () => true;

	/** The newest request's state; a pending one a later pick superseded reads as none. */
	get link(): { readonly id: string; readonly state: RawLinkState } | null {
		const link = this.#link;
		return link?.state === "pending" && !this.#still() ? null : link;
	}

	reset(): void {
		this.#request = undefined;
		this.#link = null;
	}

	retirePendingOutside(rows: readonly DeviceEvent[]): void {
		const link = this.#link;
		if (link?.state === "pending" && !rows.some(({ id }) => id === link.id))
			this.reset();
	}

	async open(
		event: DeviceEvent,
		around: (input: LogAroundInput) => Promise<LogAroundOutput>,
		show: (page: AroundPage) => void,
		still: () => boolean = () => true,
	): Promise<void> {
		// The pending action stays focusable (aria-disabled), so a repeat press lands here; once a pick
		// superseded it, a press asks again.
		const pending = this.#link;
		if (
			pending?.id === event.id &&
			pending.state === "pending" &&
			this.#still()
		)
			return;
		const request = {};
		this.#request = request;
		this.#still = still;
		this.#link = { id: event.id, state: "pending" };
		let state: RawLinkState;
		try {
			const result = await around({
				bootId: event.bootId,
				at: event.at,
				eventId: event.id,
			});
			if (request !== this.#request) return;
			// A pick after the press is the later action: no navigation and no note.
			if (!still()) {
				this.reset();
				return;
			}
			if (result.ok) {
				this.#link = null;
				show(result);
				return;
			}
			state =
				result.error === "BOOT_UNAVAILABLE"
					? "removed"
					: result.error === "BUSY"
						? "busy"
						: "failed";
		} catch (error) {
			if (request !== this.#request) return;
			if (!still()) {
				this.reset();
				return;
			}
			console.error(
				"System Logs could not open the raw logs of an event:",
				error,
			);
			state = "failed";
		}
		this.#link = { id: event.id, state };
	}
}
