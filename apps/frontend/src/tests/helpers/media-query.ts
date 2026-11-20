/**
 * A query-aware `window.matchMedia` for component tests. `decide` answers each
 * query; `set` swaps the answer and dispatches `change` on every list, which is
 * what `svelte/reactivity`'s `MediaQuery` listens to, so a test can cross a
 * breakpoint after mount.
 */
type Decide = (query: string) => boolean;

export interface MediaQueryControl {
	set(next: Decide): void;
	restore(): void;
}

export function installMediaQueries(initial: Decide): MediaQueryControl {
	const original = window.matchMedia;
	let decide = initial;
	const lists: EventTarget[] = [];

	class TestMediaQueryList extends EventTarget {
		onchange = null;
		constructor(readonly media: string) {
			super();
		}
		get matches(): boolean {
			return decide(this.media);
		}
		addListener(listener: EventListener): void {
			this.addEventListener("change", listener);
		}
		removeListener(listener: EventListener): void {
			this.removeEventListener("change", listener);
		}
	}

	window.matchMedia = (query: string): MediaQueryList => {
		const list = new TestMediaQueryList(query);
		lists.push(list);
		return list as unknown as MediaQueryList;
	};

	return {
		set(next) {
			decide = next;
			for (const list of lists) list.dispatchEvent(new Event("change"));
		},
		restore() {
			window.matchMedia = original;
		},
	};
}
