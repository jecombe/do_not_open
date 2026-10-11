/**
 * Whether `text` has the shape of an ERC-5564 stealth meta-address: `st:eth:0x` (or bare `0x`)
 * and 66 bytes, the compressed spending and viewing keys. The shape only, with no curve library:
 * the adapter's `doors().resolve` checks the keys themselves.
 */
export function isStealthMeta(text: string): boolean {
  return /^(st:eth:)?0x[0-9a-fA-F]{132}$/i.test(text.trim());
}
