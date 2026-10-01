const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (value: number) => String(value).padStart(2, '0');

/** A date as YYYY-MM-DD in the browser's time zone. */
export function localDay(date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** An ISO timestamp as the value of an <input type="datetime-local">. */
export function toLocalInput(iso: string): string {
  const date = new Date(iso);
  return `${localDay(date)}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const LOCAL_INPUT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function offsetOf(date: Date): string {
  const offset = -date.getTimezoneOffset();
  const minutes = Math.abs(offset);
  return `${offset >= 0 ? '+' : '-'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * A datetime-local value ("YYYY-MM-DDTHH:mm" or with ":ss") as ISO 8601 with the browser's UTC
 * offset, as the API requires; null for empty or invalid input. The wall-clock text is kept and
 * the offset is the one the browser resolves for it: in a DST gap (02:30 on the spring-forward
 * day) that is the offset after the change, in a DST overlap (02:30 on the fall-back day) the
 * offset of the first occurrence, so the result is always the same.
 */
export function fromLocalInput(local: string | null | undefined): string | null {
  const match = LOCAL_INPUT.exec(local ?? '');
  if (!match) {
    return null;
  }
  const [year, month, day, hour, minute, second] = match.slice(1).map((part) => Number(part ?? 0));
  const date = new Date(year, month - 1, day, hour, minute, second);
  const calendarOk =
    date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
  if (!calendarOk || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const seconds = match[6] ?? '00';
  return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${seconds}${offsetOf(date)}`;
}

/** Now, to the minute, with the UTC offset. */
export function nowIso(): string {
  const now = new Date();
  return `${localDay(now)}T${pad(now.getHours())}:${pad(now.getMinutes())}:00${offsetOf(now)}`;
}

/** HH:mm of an ISO timestamp in the browser's time zone. */
export function clock(iso: string): string {
  const date = new Date(iso);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** The day `days` after a YYYY-MM-DD day (negative for before). */
export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T12:00:00`);
  date.setDate(date.getDate() + days);
  return localDay(date);
}

/** "Today", "Yesterday" or a short weekday date such as "Mon 28 Sep". */
export function dayLabel(day: string, today = localDay()): string {
  if (day === today) {
    return 'Today';
  }
  if (day === addDays(today, -1)) {
    return 'Yesterday';
  }
  const date = new Date(`${day}T12:00:00`);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/** A duration between two ISO timestamps as "7 h 20 min"; a negative span gets a "−" prefix. */
export function duration(from: string, to: string): string {
  const signed = Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000);
  const minutes = Math.abs(signed);
  const hours = Math.floor(minutes / 60);
  const text = hours ? `${hours} h ${minutes % 60} min` : `${minutes} min`;
  return signed < 0 ? `\u2212${text}` : text;
}
