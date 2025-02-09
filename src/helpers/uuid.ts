import { invariant } from "./invariant.ts";

export async function stableUuidFromString(input: string): Promise<string> {
	// Encode the input string into a Uint8Array
	const encoder = new TextEncoder();
	const data = encoder.encode(input);

	// Hash the input using SHA-256
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));

	invariant(hashArray[6] !== undefined, "hashArray[6] is undefined");
	invariant(hashArray[8] !== undefined, "hashArray[8] is undefined");

	// Use the first 16 bytes for the UUID
	hashArray[6] = (hashArray[6] & 0x0f) | 0x40; // Set version to 4 (UUIDv4)
	hashArray[8] = (hashArray[8] & 0x3f) | 0x80; // Set variant to RFC 4122

	// Convert to UUID string format
	const hex = hashArray
		.slice(0, 16)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
	return `${hex.substring(0, 8)}-${hex.substring(8, 12)}-${hex.substring(12, 16)}-${hex.substring(16, 20)}-${hex.substring(20, 32)}`;
}
