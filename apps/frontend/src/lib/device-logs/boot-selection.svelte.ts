/**
 * The boot chosen in the System Logs boot picker, `null` for All boots. The
 * side-column picker, the header boot button and the Events and Raw logs tab
 * stores all read it. It is module state rather than a context because the
 * dialog header and the view body are separate roots. LogsDialog ties it to the
 * open view: any close or unmount resets it, so a choice never outlives the
 * view, and while open it rechecks the choice after stored history is deleted.
 */
import type { LogBootInfo } from "@ceraui/rpc/schemas";
import type { RawFilter } from "./raw-filter";

type BootListener = (bootId: string | null) => void;

class BootSelection {
	#boot = $state.raw<LogBootInfo | null>(null);
	/** What an open Raw logs tab shows; `anchored` while it shows a moment within that scope. */
	rawScope = $state.raw<
		| (Pick<RawFilter, "time" | "bootId"> & { readonly anchored?: boolean })
		| null
	>(null);
	readonly #listeners = new Set<BootListener>();
	readonly #pickListeners = new Set<() => void>();

	get boot(): LogBootInfo | null {
		return this.#boot;
	}

	get bootId(): string | null {
		return this.#boot?.bootId ?? null;
	}

	isSelected(boot: LogBootInfo | null): boolean {
		const scope = this.rawScope;
		if (scope === null) return (boot?.bootId ?? null) === this.bootId;
		if (scope.bootId !== null) return boot?.bootId === scope.bootId;
		return boot === null
			? scope.time === "all"
			: scope.time === "current" && boot.current;
	}

	/** Reusing the same boot is a no-op only when Raw already shows its whole scope, not a moment in it. */
	choose(boot: LogBootInfo | null): void {
		for (const listener of this.#pickListeners) listener();
		const bootId = boot?.bootId ?? null;
		if (
			bootId === this.bootId &&
			this.isSelected(boot) &&
			!this.rawScope?.anchored
		)
			return;
		this.#boot = boot;
		for (const listener of this.#listeners) {
			try {
				listener(bootId);
			} catch (error) {
				console.error("System Logs boot listener failed:", error);
			}
		}
	}

	/** Every choice, a repeat of the shown one included (System Logs: Export then follows the picker). */
	onPick(listener: () => void): () => void {
		this.#pickListeners.add(listener);
		return () => {
			this.#pickListeners.delete(listener);
		};
	}

	onChoose(listener: BootListener): () => void {
		this.#listeners.add(listener);
		return () => {
			this.#listeners.delete(listener);
		};
	}

	/** Back to All boots without telling anyone: the view closed. */
	reset(): void {
		this.#boot = null;
		this.rawScope = null;
	}

	/**
	 * After stored history was deleted: back to All boots, telling the stores,
	 * when the device no longer lists the chosen boot. A failed read keeps the
	 * choice, and so does a boot chosen while the list was being read.
	 */
	async recheck(read: () => Promise<readonly LogBootInfo[]>): Promise<void> {
		const chosen = this.bootId;
		if (chosen === null) return;
		try {
			const boots = await read();
			if (
				this.bootId === chosen &&
				!boots.some((boot) => boot.bootId === chosen)
			)
				this.choose(null);
		} catch (error) {
			console.error("System Logs could not re-check the chosen boot:", error);
		}
	}
}

export const bootSelection = new BootSelection();
