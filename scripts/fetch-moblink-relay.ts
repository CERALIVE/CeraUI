import { chmod } from "node:fs/promises";

const ref = "main";
const target = "dist/moblink-rust-relay";

console.log(`Downloading relay (${ref}) to ${target}...`);

const response = await fetch(
	`https://github.com/moo-the-cow/moblink-rust-relay/raw/refs/heads/${ref}/releases/linux_arm64/moblink-rust-relay`,
);
if (!response.ok) {
	throw new Error(`Failed to download relay: ${response.statusText}`);
}

const buffer = await response.arrayBuffer();
await Bun.write(target, buffer);

const bytesFormat = new Intl.NumberFormat("en-US", {
	notation: "compact",
	style: "unit",
	unit: "byte",
	unitDisplay: "narrow",
});

console.log(
	`Downloaded relay to ${target} with a size of ${bytesFormat.format(buffer.byteLength)}`,
);

await chmod(target, 0o755); // Sets the executable flag
