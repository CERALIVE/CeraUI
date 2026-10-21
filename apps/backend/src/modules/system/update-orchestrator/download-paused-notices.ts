import { isNotificationDismissed } from "../../ui/notification-dismissals.ts";
import {
	DOWNLOAD_PAUSED_LEDGER_CAPACITY,
	type DownloadInterruption,
	type DownloadPausedRecord,
	precedingHoldEntries,
} from "./download-paused-ledger.ts";
import type {
	DownloadPausedNoticePorts,
	NoticeAction,
} from "./download-paused-ports.ts";

export type { DownloadPausedNoticePorts } from "./download-paused-ports.ts";

/** One bounded queue/flight. All I/O and publication start on a macrotask. */
export class DownloadPausedNotices {
	private readonly queue: NoticeAction[] = [];
	private readonly withdrawn = new Map<string, string | undefined>();
	private packageSuccessor: string | undefined;
	private readonly announced = new Set<string>();
	private readonly pending = new Map<string, DownloadInterruption>();
	private timer: ReturnType<typeof setTimeout> | undefined;
	private running = false;
	private disposed = false;
	private overflow = false;
	private readonly waiters: Array<() => void> = [];
	constructor(private readonly ports: DownloadPausedNoticePorts) {}

	interrupted(fact: DownloadInterruption): void {
		if (this.pending.has(fact.id) || this.announced.has(fact.id)) return;
		if (this.pending.size < 128) this.pending.set(fact.id, fact);
		this.enqueue({ kind: "interrupted", fact });
	}

	withdraw(candidate: string, successorId?: string): void {
		for (const [id, fact] of this.pending)
			if (fact.candidate === candidate && id !== successorId)
				this.pending.delete(id);
		// Revoke queued/awaiting publication before detached storage catches up.
		if (
			this.withdrawn.size < 128 &&
			this.enqueue({
				kind: "withdraw",
				candidate,
				...(successorId ? { successorId } : {}),
			})
		)
			this.withdrawn.set(candidate, successorId);
	}

	hydrate(): void {
		if (
			this.packageSuccessor &&
			!this.queue.some((action) => action.kind === "replace-packages")
		)
			this.enqueue({
				kind: "replace-packages",
				successorId: this.packageSuccessor,
			});
		for (const fact of this.pending.values())
			if (
				!this.queue.some(
					(action) =>
						action.kind === "interrupted" && action.fact.id === fact.id,
				)
			)
				this.enqueue({ kind: "interrupted", fact });
		if (!this.queue.some((action) => action.kind === "hydrate"))
			this.enqueue({ kind: "hydrate" });
	}

	dispose(): void {
		this.disposed = true;
		if (this.timer) clearTimeout(this.timer);
		this.queue.length = 0;
		for (const resolve of this.waiters.splice(0)) resolve();
	}

	replacePackages(successorId: string): void {
		this.packageSuccessor = successorId;
		this.enqueue({ kind: "replace-packages", successorId });
	}

	settled(): Promise<void> {
		if (!this.running && !this.timer) return Promise.resolve();
		return new Promise((resolve) => this.waiters.push(resolve));
	}

	private enqueue(action: NoticeAction): boolean {
		if (this.disposed) return false;
		const accepted = this.queue.length < 128;
		if (accepted) this.queue.push(action);
		else this.overflow = true;
		this.schedule();
		return accepted;
	}

	private schedule(): void {
		if (this.running || this.timer || this.disposed) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.run();
		}, 0);
		this.timer.unref();
	}

	private async run(): Promise<void> {
		this.running = true;
		let active = true;
		let deadline: ReturnType<typeof setTimeout> | undefined;
		try {
			if (this.overflow) {
				this.overflow = false;
				this.ports.report("queue-full");
			}
			const action = this.queue.shift();
			if (!action) return;
			deadline = setTimeout(() => {
				active = false;
				this.ports.report("worker-timeout");
			}, 1000);
			deadline.unref();
			await this.apply(action, () => active && !this.disposed);
		} catch {
			// Detached exception boundary: never propagate into admission/ticks.
			this.ports.report("publication-failed");
		} finally {
			active = false;
			if (deadline) clearTimeout(deadline);
			this.running = false;
			if (this.queue.length) this.schedule();
			else for (const resolve of this.waiters.splice(0)) resolve();
		}
	}

	private async apply(
		action: NoticeAction,
		active: () => boolean,
	): Promise<void> {
		let entries: readonly DownloadPausedRecord[];
		try {
			entries = await this.ports.ledger.read();
		} catch {
			this.ports.report("read-unavailable");
			return;
		}
		if (!active()) return;
		switch (action.kind) {
			case "replace-packages": {
				// The single package pipeline's next accepted launch supersedes its
				// last interrupted transaction, even when memory was lost at restart.
				const previous = precedingHoldEntries(entries, action.successorId)
					.slice()
					.reverse()
					.find((entry) => entry.id.startsWith("packages:"));
				if (previous?.status === "active")
					this.withdraw(previous.candidate, action.successorId);
				if (this.packageSuccessor === action.successorId)
					this.packageSuccessor = undefined;
				return;
			}
			case "interrupted": {
				const existing = entries.find((entry) => entry.id === action.fact.id);
				if (existing && existing.status !== "active") {
					this.pending.delete(action.fact.id);
					return;
				}
				const record = existing ?? {
					...action.fact,
					status: "active" as const,
				};
				this.pending.delete(action.fact.id);
				if (!existing) {
					const retained =
						entries.length < DOWNLOAD_PAUSED_LEDGER_CAPACITY
							? entries
							: entries.filter((entry) => entry.status !== "withdrawn");
					if (retained.length >= DOWNLOAD_PAUSED_LEDGER_CAPACITY)
						this.ports.report("ledger-full");
					else {
						try {
							await this.ports.ledger.write([...retained, record]);
						} catch {
							this.ports.report("write-failed");
						}
					}
				}
				if (active() && this.visible(record)) await this.publish(record);
				return;
			}
			case "withdraw": {
				const matches = precedingHoldEntries(
					entries,
					action.successorId,
				).filter(
					(entry) =>
						entry.candidate === action.candidate && entry.status === "active",
				);
				if (matches.length) {
					let committed = false;
					try {
						await this.ports.ledger.write(
							entries.map((entry) =>
								matches.includes(entry)
									? { ...entry, status: "withdrawn" }
									: entry,
							),
						);
						committed = true;
					} catch {
						this.ports.report("write-failed");
					}
					if (active())
						for (const entry of matches) {
							this.announced.delete(entry.id);
							this.ports.clear(entry.id);
						}
					if (!committed) return;
				}
				if (this.withdrawn.get(action.candidate) === action.successorId)
					this.withdrawn.delete(action.candidate);
				return;
			}
			case "hydrate":
				for (const [candidate, successorId] of this.withdrawn)
					if (
						!this.queue.some(
							(pending) =>
								pending.kind === "withdraw" && pending.candidate === candidate,
						)
					)
						this.enqueue({
							kind: "withdraw",
							candidate,
							...(successorId ? { successorId } : {}),
						});
				for (const entry of entries) {
					if (!active()) return;
					if (entry.status === "active" && this.visible(entry))
						await this.publish(entry);
				}
				return;
			default: {
				const exhaustive: never = action;
				return exhaustive;
			}
		}
	}

	private visible(fact: DownloadInterruption): boolean {
		return (
			!this.withdrawn.has(fact.candidate) ||
			this.withdrawn.get(fact.candidate) === fact.id
		);
	}

	private async publish(fact: DownloadInterruption): Promise<void> {
		if (this.announced.has(fact.id)) return;
		// Reconcile old shared dismissals too; new dismissals write our ledger first.
		if (isNotificationDismissed(`update:download-paused:${fact.id}`)) {
			this.ports.ledger.acknowledge(fact.id);
			return;
		}
		await this.ports.publish(fact, () =>
			this.ports.ledger.acknowledge(fact.id),
		);
		if (this.announced.size < 4096) this.announced.add(fact.id);
	}
}
