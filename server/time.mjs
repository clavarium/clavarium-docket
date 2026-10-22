/* TIME, for reminders: a wall-clock time in a time zone, a cron line, and when
 * it is next due. No dependency: the time zones are the platform's (Intl).
 */

/* The time zone a folder works in: $DOCKET_TZ, else the machine's. */
export function zoneOf(env = process.env) {
    const given = String(env.DOCKET_TZ ?? '').trim();
    if (given && isZone(given)) return given;
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
export function isZone(tz) { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return /^[A-Za-z0-9_+\-/]{1,64}$/.test(tz); } catch { return false; } }

const formats = new Map();
const format = (tz) => {
    if (!formats.has(tz)) formats.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }));
    return formats.get(tz);
};
const DAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
/* What a clock on the wall shows at `t` (milliseconds) in `tz`. */
export function wall(t, tz) {
    const p = Object.fromEntries(format(tz).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour % 24, minute: +p.minute, weekday: DAYS[p.weekday] };
}
/* The moment a wall clock in `tz` shows that time; one near it, for a time a clock skips or shows twice. */
export function moment({ year, month, day, hour = 0, minute = 0 }, tz) {
    const asUtc = Date.UTC(year, month - 1, day, hour, minute);
    let t = asUtc;
    for (let i = 0; i < 3; i++) {
        const w = wall(t, tz);
        const shown = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
        if (shown === asUtc) return t;
        t += asUtc - shown;
    }
    return t;
}

/* "2026-10-23 09:00", "2026-10-23T09:00", with seconds or an offset ("+02:00", "Z"), or a date alone (00:00). */
const WHEN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;
export function parseWhen(text, tz) {
    const m = WHEN.exec(String(text ?? '').trim());
    if (!m) return null;
    const [, y, mo, d, h = '0', mi = '0', , off] = m;
    const parts = { year: +y, month: +mo, day: +d, hour: +h, minute: +mi };
    if (parts.month < 1 || parts.month > 12 || parts.day < 1 || parts.day > 31 || parts.hour > 23 || parts.minute > 59) return null;
    if (new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDate() !== parts.day) return null;
    if (off) {
        const sign = off === 'Z' ? 0 : off[0] === '-' ? -1 : 1;
        const [oh, om] = off === 'Z' ? [0, 0] : [+off.slice(1, 3), +off.slice(-2)];
        return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - sign * (oh * 60 + om) * 60_000;
    }
    return moment(parts, tz);
}
/* "45m", "2h", "3d": from now. */
export function parseIn(text) {
    const m = /^(\d{1,4})\s*(m|min|h|d)$/i.exec(String(text ?? '').trim());
    if (!m) return null;
    const unit = { m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 }[m[2].toLowerCase()];
    const ms = +m[1] * unit;
    return ms > 0 ? ms : null;
}

/* A CRON LINE: minute hour day-of-month month day-of-week; *, lists, ranges, steps.
   Day of the week 0-7 (0 and 7 Sunday). As cron does: when both days are given, either one matches. */
const FIELDS = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
export function parseCron(line) {
    const parts = String(line ?? '').trim().split(/\s+/);
    if (parts.length !== 5) return null;
    const sets = [];
    for (let i = 0; i < 5; i++) {
        const [lo, hi] = FIELDS[i];
        const set = new Set();
        for (const piece of parts[i].split(',')) {
            const m = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(piece);
            if (!m) return null;
            const step = m[4] === undefined ? 1 : +m[4];
            if (step < 1) return null;
            let from = lo; let to = hi;
            if (m[1] !== '*') { from = +m[2]; to = m[3] === undefined ? (m[4] === undefined ? from : hi) : +m[3]; }
            if (from < lo || to > hi || from > to) return null;
            for (let v = from; v <= to; v += step) set.add(i === 4 && v === 7 ? 0 : v);
        }
        sets.push(set);
    }
    return { minutes: sets[0], hours: sets[1], days: sets[2], months: sets[3], weekdays: sets[4], anyDay: parts[2] === '*', anyWeekday: parts[4] === '*' };
}
const dayMatches = (c, w) => {
    if (c.anyDay && c.anyWeekday) return true;
    if (c.anyDay) return c.weekdays.has(w.weekday);
    if (c.anyWeekday) return c.days.has(w.day);
    return c.days.has(w.day) || c.weekdays.has(w.weekday);
};
export const cronMatches = (c, t, tz) => { const w = wall(t, tz); return c.minutes.has(w.minute) && c.hours.has(w.hour) && c.months.has(w.month) && dayMatches(c, w); };
/* The first minute strictly after `after` that the line matches, within a year and a day; null if none. */
export function nextCron(c, after, tz) {
    let t = Math.floor(after / 60_000) * 60_000 + 60_000;
    const end = after + 367 * 86_400_000;
    while (t <= end) {
        const w = wall(t, tz);
        if (!c.months.has(w.month) || !dayMatches(c, w)) {
            /* The next day, from its first minute (a day may be 23 or 25 hours long). */
            const n = wall(t + (24 * 60 - w.hour * 60 - w.minute) * 60_000 + 3_600_000, tz);
            const next = moment({ year: n.year, month: n.month, day: n.day }, tz);
            t = next > t ? next : t + 3_600_000;
            continue;
        }
        if (!c.hours.has(w.hour)) { t += (60 - w.minute) * 60_000; continue; }
        if (c.minutes.has(w.minute)) return t;
        t += 60_000;
    }
    return null;
}
/* The last minute after `since` and at or before `upTo` that the line matches; null if none. */
export function lastCron(c, since, upTo, tz) {
    let found = null;
    for (let t = nextCron(c, since, tz); t !== null && t <= upTo; t = nextCron(c, t, tz)) found = t;
    return found;
}
