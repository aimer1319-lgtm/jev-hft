// US stock market hours, in New York time whatever the machine's own time zone is.

export type Session = 'pre' | 'regular' | 'post' | 'closed' | '24/7';

const nyClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const nyDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }); // YYYY-MM-DD

/**
 * US equity session at time t. Exchange holidays and early closes are not modeled: on those
 * days quotes are missing or very wide, and the spread checks keep them out of the results.
 */
export function usSession(t: number): Exclude<Session, '24/7'> {
  const p = Object.fromEntries(nyClock.formatToParts(t).map(x => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  const minute = Number(p.hour) * 60 + Number(p.minute);
  if (minute >= 4 * 60 && minute < 9 * 60 + 30) return 'pre';
  if (minute >= 9 * 60 + 30 && minute < 16 * 60) return 'regular';
  if (minute >= 16 * 60 && minute < 20 * 60) return 'post';
  return 'closed';
}

/** The calendar date in New York at time t, as YYYY-MM-DD. */
export const nyDate = (t: number) => nyDay.format(t);
