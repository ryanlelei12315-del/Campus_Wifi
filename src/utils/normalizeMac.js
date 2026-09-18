/**
 * Normalizes a MAC address to the canonical AA:BB:CC:DD:EE:FF form.
 *
 * Accepts the shapes that show up in practice — upper/lower case, dashes,
 * dots or no separators at all ("aabbccddeeff", "AA-BB-CC-DD-EE-FF") — and
 * collapses a bare 12-character hex string into colon-separated octets.
 * Anything it cannot confidently parse is returned trimmed and upper-cased so
 * the caller still stores exactly what the admin typed.
 *
 * Returns null for empty/whitespace input.
 */
function normalizeMac(rawMac) {
  if (!rawMac) return null;
  const cleaned = String(rawMac).trim().toUpperCase();
  if (!cleaned) return null;
  const hexOnly = cleaned.replace(/[^0-9A-F]/g, '');
  if (hexOnly.length === 12) {
    return hexOnly.match(/.{1,2}/g).join(':');
  }
  return cleaned;
}

module.exports = { normalizeMac };