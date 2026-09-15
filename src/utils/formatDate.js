const DEFAULT_TIMEZONE = process.env.TIMEZONE || 'Africa/Nairobi';

/**
 * Parses any date representation (SQLite UTC 'YYYY-MM-DD HH:MM:SS', ISO string, or Date)
 * into a valid JavaScript Date object in UTC.
 */
function parseDate(dateInput) {
  if (!dateInput) return null;
  if (dateInput instanceof Date) return isNaN(dateInput.getTime()) ? null : dateInput;

  let str = String(dateInput).trim();
  if (!str) return null;

  // SQLite datetime('now') produces 'YYYY-MM-DD HH:MM:SS'.
  // If no timezone offset is present, treat it as UTC by converting space to 'T' and appending 'Z'.
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(str)) {
    str = str.replace(' ', 'T') + 'Z';
  } else if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(str)) {
    str = str + 'Z';
  }

  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Formats a date string or Date object in East Africa Time / configured timezone.
 * Defaults to e.g. "Sep 15, 2026, 12:43 PM".
 */
function formatDateTime(dateInput, options = {}) {
  const d = parseDate(dateInput);
  if (!d) return '—';

  const defaultOptions = {
    timeZone: DEFAULT_TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  };

  return new Intl.DateTimeFormat('en-KE', { ...defaultOptions, ...options }).format(d);
}

/**
 * Returns a standardized UTC string for database persistence: 'YYYY-MM-DD HH:MM:SS'
 */
function toSqliteUtc(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

module.exports = {
  parseDate,
  formatDateTime,
  toSqliteUtc,
  DEFAULT_TIMEZONE,
};

