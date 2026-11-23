/**
 * Whole-word credential key names, shared by the logger's key walker and the
 * support-bundle and export text redaction so both apply one rule.
 */

/**
 * Credential words, matched as WHOLE words of a key after splitting it on case
 * changes, separators and dots. The logger's `SENSITIVE_KEY_RE` is a substring match,
 * so it cannot hold `pass` (it would eat `video_passthrough` and every `bypass`)
 * or `key` (every `keyframe`); split into words they are safe, and `ssh_pass`,
 * `sshPassHash`, `wifi-pwd` and `remote_key` are caught without naming each one.
 */
const SECRET_KEY_WORDS: ReadonlySet<string> = new Set<string>([
	"pass",
	"passwd",
	"pwd",
	"passcode",
	"passkey",
	"psk",
	"privkey",
	"apikey",
	"secret",
	"secrets",
	"password",
	"passwords",
	"passphrase",
]);

/** A `key` or `hash` word is key material when one of these words names it. */
const KEY_MATERIAL_QUALIFIERS: ReadonlySet<string> = new Set<string>([
	"remote",
	"private",
	"priv",
	"ssh",
	"api",
	"ingest",
	"stream",
	"signing",
	"access",
	"session",
	"pairing",
	"shared",
	"preshared",
	"encryption",
	"wireguard",
	"wg",
	"shadow",
]);

/** Lower-case words of a key: `sshPassHash`, `ssh_pass_hash` and `ssh.pass-hash` all give ssh, pass, hash. */
export function keyWords(key: string): string[] {
	return key
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((word) => word.length > 0);
}

/** Words that may follow `key` or `hash` and still name the material itself. */
const KEY_FORMAT_WORDS: ReadonlySet<string> = new Set<string>([
	"pem",
	"der",
	"hex",
	"b64",
	"base64",
	"raw",
	"value",
	"data",
]);

const MATERIAL_WORDS: ReadonlySet<string> = new Set<string>([
	"key",
	"keys",
	"hash",
]);

/**
 * Whole-word credential test: a secret word, or key material.
 *
 * Key material is a `key`, `keys` or `hash` word that ends the key (format
 * words such as `pem` may follow) and is named by a qualifier: the word right
 * before it (`remote_key`, `private_key_pem`, `api_key`), or the parent key when
 * the key is that word alone (`{ remote: { key } }`, `{ ssh: { hash } }`).
 * `keyCount`, `remoteCommitHash`, `commitHash` under `remote` and
 * `{ video: { key } }` stay readable.
 */
export function isSecretWordKey(key: string, parentKey?: string): boolean {
	const words = keyWords(key);
	if (words.some((word) => SECRET_KEY_WORDS.has(word))) return true;
	let index = words.length - 1;
	while (index > 0 && KEY_FORMAT_WORDS.has(words[index] ?? "")) index--;
	if (!MATERIAL_WORDS.has(words[index] ?? "")) return false;
	if (index > 0) return KEY_MATERIAL_QUALIFIERS.has(words[index - 1] ?? "");
	// The key is the material word alone: its parent names it.
	return (
		parentKey !== undefined &&
		keyWords(parentKey).some((word) => KEY_MATERIAL_QUALIFIERS.has(word))
	);
}
