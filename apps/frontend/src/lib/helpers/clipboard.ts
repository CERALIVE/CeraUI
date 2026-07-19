/**
 * Copy `text` to the clipboard, working over plain HTTP as well as HTTPS.
 *
 * `navigator.clipboard` only exists in a secure context (HTTPS or localhost), so
 * a device reached over plain HTTP by LAN IP has no Clipboard API and copy
 * buttons silently fail. Fall back to a hidden `<textarea>` +
 * `document.execCommand('copy')` when the async API is absent or throws, so
 * copying works without a real TLS certificate.
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

function legacyCopy(text: string): boolean {
	if (typeof document === "undefined") return false;

	const textarea = document.createElement("textarea");
	textarea.value = text;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.top = "-9999px";
	textarea.style.opacity = "0";
	document.body.appendChild(textarea);

	try {
		textarea.focus();
		textarea.select();
		return document.execCommand("copy");
	} catch {
		return false;
	} finally {
		document.body.removeChild(textarea);
	}
}
