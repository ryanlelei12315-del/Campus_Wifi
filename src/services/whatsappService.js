// Evolution API (WhatsApp) wrapper — outbound text messages only.
//
// Endpoint: POST {EVOLUTION_API_URL}/message/sendText/{EVOLUTION_INSTANCE_NAME}
// Auth:     `apikey` header carrying EVOLUTION_API_KEY
// Body:     { number: "2547XXXXXXXX", text: "..." }
//
// Uses the built-in fetch (Node 18+/22) — no external HTTP dependency.
// sendWhatsAppText NEVER throws: it always resolves to { ok, error? } so the
// scheduler can keep running even while the Evolution server is down.

const EVOLUTION_API_URL = (process.env.EVOLUTION_API_URL || '').replace(/\/+$/, '');
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
const EVOLUTION_INSTANCE_NAME = process.env.EVOLUTION_INSTANCE_NAME || '';
const REQUEST_TIMEOUT_MS = 10 * 1000;

let unconfiguredWarned = false;

/**
 * Normalizes any Kenyan phone representation to international format 254XXXXXXXXX.
 * Accepts: 07XXXXXXXX, 01XXXXXXXX, +2547XXXXXXXX, 254 7XX ... (spaces/dashes ok).
 * Returns null when the input cannot be a valid Kenyan mobile number.
 */
function normalizeKenyanPhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d]/g, ''); // strip +, spaces, dashes
  if (digits.startsWith('254')) {
    digits = digits.slice(3);
  } else if (digits.startsWith('0')) {
    digits = digits.slice(1);
  }
  // Kenyan mobiles: 9 digits after the prefix, starting with 7 (or 1 for newer ranges).
  return /^[17]\d{8}$/.test(digits) ? `254${digits}` : null;
}

/**
 * True when all three Evolution API settings are present. Exported so the UI can
 * warn the admin when alerts would be silently skipped rather than sent.
 */
function isWhatsAppConfigured() {
  return Boolean(EVOLUTION_API_URL && EVOLUTION_API_KEY && EVOLUTION_INSTANCE_NAME);
}

/**
 * Sends a WhatsApp text via the Evolution API.
 * @returns {Promise<{ok: boolean, error?: string, skipped?: boolean}>}
 */
async function sendWhatsAppText(phoneNumber, text) {
  if (!isWhatsAppConfigured()) {
    if (!unconfiguredWarned) {
      console.warn(
        '[WHATSAPP] Evolution API is not configured — messages are being skipped. ' +
        'Set EVOLUTION_API_URL, EVOLUTION_API_KEY and EVOLUTION_INSTANCE_NAME in .env.'
      );
      unconfiguredWarned = true;
    }
    console.log(`[WHATSAPP:SKIPPED] -> ${phoneNumber}: ${text}`);
    return { ok: false, skipped: true, error: 'Evolution API not configured' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(
      `${EVOLUTION_API_URL}/message/sendText/${EVOLUTION_INSTANCE_NAME}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: EVOLUTION_API_KEY },
        body: JSON.stringify({ number: phoneNumber, text }),
        signal: controller.signal,
      }
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Evolution API HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    const reason = err && err.name === 'AbortError'
      ? `request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`
      : (err && err.message) || 'unknown network error';
    return { ok: false, error: `Evolution API request failed: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { sendWhatsAppText, normalizeKenyanPhone, isWhatsAppConfigured };