/** Display formatting for song details. */

const MONTH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
const FULL_DATE = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** 215000 -> "3:35"; hour-long tracks -> "1:02:05" */
export function formatDuration(ms) {
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

/**
 * Spotify's release dates can be just "1981" or "1981-12", per `precision`.
 * Dates are parsed and printed in UTC so a timezone can't shift them by a day.
 */
export function formatReleaseDate(date, precision = 'day') {
  if (!date) return 'Unknown';
  const [year, month = 1, day = 1] = date.split('-').map(Number);
  if (precision === 'year' || !date.includes('-')) return String(year);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return (precision === 'month' ? MONTH_YEAR : FULL_DATE).format(utc);
}
