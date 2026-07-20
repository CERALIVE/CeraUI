/**
 * Copy `text` to the clipboard, working over plain HTTP as well as HTTPS.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), so
 * a device reached over plain HTTP by LAN IP has no Clipboard API and copy
 * buttons silently fail. Fall back to `document.execCommand('copy')` when the
 * async API is absent or throws, so copying works without a real TLS certificate.
 *
 * @returns `true` when the text was copied, `false` when every path failed.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
	if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
		try {
			await navigator.clipboard.writeText(text);
			return true;
		} catch {
			// Secure-context API present but refused (permissions/focus) — fall
			// through to the execCommand path rather than reporting a failure.
		}
	}
	return legacyCopy(text);
}

/**
 * `document.execCommand('copy')` fallback that copies WITHOUT moving focus.
 *
 * Every copy button that uses this lives inside a bits-ui/Radix dialog. Those
 * dialogs trap focus: the instant a transient `<textarea>` is `focus()`ed, the
 * dialog's `focusout` guard synchronously pulls focus back into the dialog, so
 * the textarea never owns a selection when `execCommand('copy')` runs — the
 * command returns `true` (the success toast fires) but the OS clipboard is never
 * written, so pasting yields nothing. That is the exact "copy succeeded but paste
 * is empty" bug, and it is why the old textarea + `focus()`/`select()` approach
 * failed on the real device while passing every mocked/secure-context test.
 *
 * Selecting a detached node's contents via the Selection/Range API never touches
 * focus, so the focus trap is never triggered and the copy actually lands.
 */
function legacyCopy(text: string): boolean {
	if (typeof document === "undefined" || typeof window === "undefined") {
		return false;
	}

	const selection = window.getSelection();
	if (!selection) return false;

	const node = document.createElement("span");
	node.textContent = text;
	node.setAttribute("aria-hidden", "true");
	// Keep the node inside the viewport — some browsers refuse to range-select a
	// fully off-screen node — but 1px and inert. It is appended and removed within
	// a single synchronous tick, so the browser never paints it.
	node.style.position = "fixed";
	node.style.top = "0";
	node.style.left = "0";
	node.style.width = "1px";
	node.style.height = "1px";
	node.style.overflow = "hidden";
	node.style.whiteSpace = "pre";
	node.style.pointerEvents = "none";
	// Defend against a global `user-select: none` reset that would block selection.
	node.style.setProperty("user-select", "text");
	node.style.setProperty("-webkit-user-select", "text");

	// Preserve whatever the operator had selected so copying never clobbers it.
	const savedRanges: Range[] = [];
	for (let i = 0; i < selection.rangeCount; i++) {
		savedRanges.push(selection.getRangeAt(i));
	}

	document.body.appendChild(node);
	try {
		const range = document.createRange();
		range.selectNodeContents(node);
		selection.removeAllRanges();
		selection.addRange(range);
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		selection.removeAllRanges();
		for (const saved of savedRanges) selection.addRange(saved);
		node.remove();
	}
}
