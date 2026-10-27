/**
 * Random hotspot passwords an operator can read aloud and type on a phone: no
 * look-alikes (0/O, 1/l/I), 12 characters (~68 bits) from the CSPRNG.
 */
const ALPHABET = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LENGTH = 12;

export function generateHotspotPassword(): string {
	// Rejection sampling keeps every character equally likely.
	const limit = 256 - (256 % ALPHABET.length);
	let out = "";
	while (out.length < LENGTH) {
		for (const byte of crypto.getRandomValues(new Uint8Array(LENGTH * 2))) {
			if (byte < limit && out.length < LENGTH)
				out += ALPHABET[byte % ALPHABET.length];
		}
	}
	return out;
}

/** WPA2/WPA3 passphrases are printable ASCII only (IEEE 802.11i). */
export function hotspotPasswordIsPrintable(password: string): boolean {
	return /^[\x20-\x7E]*$/.test(password);
}
