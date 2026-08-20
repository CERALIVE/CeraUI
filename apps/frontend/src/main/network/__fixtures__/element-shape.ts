/**
 * Test-only DOM shape serializer.
 *
 * Emits the ELEMENT tree — every tag, every attribute (classes included) and
 * every text node — as a stable string, so a rendered surface can be locked
 * against a golden captured from an earlier tree.
 *
 * Exactly two things are normalized away, and only these two:
 *
 *   • Comment nodes. Svelte 5 anchors each `{#if}` block with a `<!---->` node,
 *     so adding a block that renders NOTHING still shifts raw `innerHTML`.
 *     Comparing raw strings would fail on an invisible template artifact rather
 *     than on a rendering change, which is the opposite of what the lock is for.
 *   • bits-ui's `id="bits-cN"` counter, which is per-instance render order and
 *     encodes no rendering decision.
 *
 * Everything an operator can see, or a selector can match on, is compared
 * verbatim.
 */
export function elementShape(node: Element): string {
	const attrs = Array.from(node.attributes)
		.map((a) => `${a.name}="${a.value.replace(/\bbits-c\d+\b/g, "bits-cN")}"`)
		.sort()
		.join(" ");
	const children = Array.from(node.childNodes)
		.map((child) => {
			if (child.nodeType === Node.ELEMENT_NODE)
				return elementShape(child as Element);
			if (child.nodeType === Node.TEXT_NODE) {
				return (child.textContent ?? "").replace(/\s+/g, " ").trim();
			}
			return "";
		})
		.filter((part) => part !== "")
		.join("|");
	const tag = node.tagName.toLowerCase();
	return `<${tag}${attrs === "" ? "" : ` ${attrs}`}>${children}</${tag}>`;
}

export function shapeOf(container: HTMLElement): string {
	return Array.from(container.children).map(elementShape).join("\n");
}
