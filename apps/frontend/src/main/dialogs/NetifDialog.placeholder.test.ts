// @vitest-environment jsdom
/**
 * NetifDialog — static-IP placeholder is sourced from i18n, not a hardcoded
 * literal (T17).
 *
 * The example value `192.168.1.50` used to live inline in the template. This
 * test renders the actual dialog and asserts the rendered `placeholder`
 * attribute equals the value resolved through `$LL` (the runes i18n adapter
 * defaults to `en` synchronously). That proves the key resolves in the UI — a
 * missing or typo'd key would fail codegen AND make this assertion throw/diverge.
 */
import { getLL } from "@ceraui/i18n/svelte";
import { render } from "@testing-library/svelte";
import { beforeAll, describe, expect, it, vi } from "vitest";

import NetifDialog from "./NetifDialog.svelte";

// `setNetif` only fires on save (never in this test); mock it so rendering the
// dialog never touches the RPC client / websocket store.
vi.mock("$lib/helpers/NetworkHelper", () => ({
	setNetif: vi.fn(),
}));

beforeAll(() => {
	if (!window.matchMedia) {
		window.matchMedia = vi.fn().mockImplementation((query: string) => ({
			matches: true,
			media: query,
			onchange: null,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(),
		}));
	}
});

describe("NetifDialog — IP placeholder resolves from i18n", () => {
	it("renders the static-IP input with the placeholder from $LL, not a hardcoded literal", () => {
		render(NetifDialog, {
			props: { open: true, name: "eth0", iface: undefined },
		});

		const input = document.getElementById("netif-ip") as HTMLInputElement | null;
		expect(input).toBeTruthy();

		const resolved = getLL().settings.dialogs.ipPlaceholder();
		// Guard against the tautology where a missing key falls back to its own
		// path string: the resolved value must be the migrated example literal.
		expect(resolved).toBe("192.168.1.50");
		expect(resolved).not.toBe("settings.dialogs.ipPlaceholder");

		// The rendered UI must use exactly that i18n-resolved value.
		expect(input?.placeholder).toBe(resolved);
	});
});
