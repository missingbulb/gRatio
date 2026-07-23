// Due-slot math for the vendored hourly scheduler (per-project-scheduling
// DESIGN §3). Pure and stateless: given the repo's `schedule` anchor, the
// frequencies its tasks declare, the current time `now`, and the timestamp
// `lastSuccess` of the scheduler's last SUCCESSFUL run (read from the Actions
// run ledger GitHub already keeps — there is no watermark file to corrupt),
// this decides exactly which frequencies are due and the slot id each is
// running under.
//
// The whole model is: consider ONLY the single most-recent scheduled slot per
// frequency, and it is due iff its time falls in `(lastSuccess, now]`.
//   - Miss / outage self-heals — the next successful run catches up the one
//     most-recent daily/weekly/monthly slot; a 3-day outage yields one catch-up
//     evaluation per frequency, never a backfill storm (DESIGN §3.1).
//   - HOURLY never catches up for free: its most-recent slot is always the
//     current hour, so an outage evaluates the current poll once and never a
//     stale one — no special case needed, the most-recent-only rule delivers it.
//   - Late / early fire is irrelevant: due-ness is schedule math, never
//     wall-clock equality with the (hashed :10–:50) cron minute.
//   - First run (`lastSuccess` null / fresh adoption) → every frequency's
//     most-recent slot is due: the immediate full evaluation that smoke-tests a
//     newly-wired repo (DESIGN §3.1).
//
// All times are UTC (the `schedule` values are UTC by contract, DESIGN §2). This
// module never reads the clock itself — `now` is always injected — so the whole
// due-ness decision is deterministic and testable.

// The seven legal frequency tokens (DESIGN §1). `task-declaration-shape` is what
// rejects anything outside this set at author time; here an unknown token is
// simply never due (defensive — the scheduler must not throw on a stray value).
export const FREQUENCIES = ['hourly', 'daily-2h', 'daily-1h', 'daily', 'daily+1h', 'weekly', 'monthly'];

// The documented anchor defaults (DESIGN §2) — applied when a repo omits
// `schedule` or any of its keys. This is the single source of these values; the
// checks layer's load-time range validation (engine/checks/helpers/repo-context.mjs)
// only bounds them, it does not re-declare them.
export const DEFAULT_SCHEDULE = { dailyHour: 4, weeklyDay: 'Sun', monthlyDay: 1 };

// Sun-indexed to match Date#getUTCDay (0 = Sunday). Also the canonical weekday
// vocabulary the config validator mirrors.
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Hours the daily family offsets the anchor hour by (DESIGN §2).
const DAILY_OFFSETS = { 'daily-2h': -2, 'daily-1h': -1, daily: 0, 'daily+1h': 1 };

const HOUR_MS = 3600 * 1000;
const DAY_MS = 24 * HOUR_MS;
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// Last calendar day of a UTC month (day 0 of the next month rolls back).
const daysInMonth = (year, monthIndex) => new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();

// Fill any absent key with its documented default; leave present values
// untouched (the checks layer has already range-validated them at load).
export function normalizeSchedule(schedule = {}) {
  const s = schedule || {};
  return {
    dailyHour: Number.isInteger(s.dailyHour) ? s.dailyHour : DEFAULT_SCHEDULE.dailyHour,
    weeklyDay: WEEKDAYS.includes(s.weeklyDay) ? s.weeklyDay : DEFAULT_SCHEDULE.weeklyDay,
    monthlyDay: Number.isInteger(s.monthlyDay) ? s.monthlyDay : DEFAULT_SCHEDULE.monthlyDay,
  };
}

// The most-recent scheduled slot for one frequency at time `now`:
// `{ time: Date, id: string }` where `time` is the slot's UTC instant (≤ now)
// and `id` is the dispatch-issue slot id (DESIGN §4). `schedule` is assumed
// already normalized. `now` may be a Date or anything the Date ctor accepts.
export function mostRecentSlot(frequency, schedule, now) {
  const s = normalizeSchedule(schedule);
  now = new Date(now);
  const nowMs = now.getTime();

  if (frequency === 'hourly') {
    // The top of the current hour — the poll never backfills a past hour.
    const time = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    return { time, id: `h${ymd(time)}T${pad(time.getUTCHours())}Z` };
  }

  if (frequency in DAILY_OFFSETS) {
    const off = DAILY_OFFSETS[frequency];
    // Walk anchor DATES back from today until the slot instant is ≤ now. The id
    // keeps the ANCHOR date, so a `daily-2h` with dailyHour < 2 whose instant
    // lands on the previous calendar day still carries the anchor's date — the
    // wrap behavior of DESIGN §2 falls out for free.
    let anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    for (;;) {
      const time = new Date(anchor.getTime() + (s.dailyHour + off) * HOUR_MS);
      if (time.getTime() <= nowMs) return { time, id: `d${ymd(anchor)}` };
      anchor = new Date(anchor.getTime() - DAY_MS);
    }
  }

  if (frequency === 'weekly') {
    const targetDow = WEEKDAYS.indexOf(s.weeklyDay);
    let date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    // Up to 8 steps guarantees the previous week's slot even when today is the
    // weekly day but earlier than dailyHour.
    for (let i = 0; i < 8; i += 1) {
      if (date.getUTCDay() === targetDow) {
        const time = new Date(date.getTime() + s.dailyHour * HOUR_MS);
        if (time.getTime() <= nowMs) return { time, id: `w${ymd(date)}` };
      }
      date = new Date(date.getTime() - DAY_MS);
    }
    // Unreachable in practice (a matching weekday always exists within 7 days).
    throw new Error(`no weekly slot resolved for ${s.weeklyDay}`);
  }

  if (frequency === 'monthly') {
    let year = now.getUTCFullYear();
    let month = now.getUTCMonth();
    for (;;) {
      const day = Math.min(s.monthlyDay, daysInMonth(year, month)); // clamp to month length (DESIGN §2)
      const time = new Date(Date.UTC(year, month, day) + s.dailyHour * HOUR_MS);
      if (time.getTime() <= nowMs) return { time, id: `m${year}-${pad(month + 1)}` };
      month -= 1;
      if (month < 0) { month = 11; year -= 1; }
    }
  }

  throw new Error(`unknown frequency "${frequency}"`);
}

// The frequencies that are due right now, each with its slot id/time. `lastSuccess`
// is the last successful scheduler run's timestamp (Date / ISO string / null);
// null means "no prior success" → everything due. Unknown frequency tokens are
// ignored (never due) rather than thrown on.
export function dueSlots(frequencies, schedule, now, lastSuccess) {
  const s = normalizeSchedule(schedule);
  now = new Date(now);
  const nowMs = now.getTime();
  const tMs = lastSuccess === null || lastSuccess === undefined ? null : new Date(lastSuccess).getTime();

  const out = [];
  for (const frequency of frequencies) {
    if (!FREQUENCIES.includes(frequency)) continue;
    const slot = mostRecentSlot(frequency, s, now);
    const t = slot.time.getTime();
    // `t <= nowMs` holds by construction; kept explicit as the stated contract.
    const due = tMs === null ? t <= nowMs : t > tMs && t <= nowMs;
    if (due) out.push({ frequency, slotId: slot.id, slotTime: slot.time.toISOString() });
  }
  return out;
}
