// Every retention knob here turns a day count into a cutoff Date and binds it
// as an ISO string. Two of those steps can fail on a value Postgres itself
// accepts — message_history_retention_days is an integer column, so one plan
// row can legally hold 2147483647 — and each failure surfaces as a thrown
// RangeError or a driver error that takes down the whole sweep.
//
// This is a REPRESENTABILITY limit and nothing else. Every finite window
// below it is honoured however odd it looks, because "that number is strange"
// is not a reason to stop sweeping a user.
//
// Measured on local pg 16 [2026-08-10]: the binding constraint is not the
// timestamptz range (4713 BC) but the year toISOString() emits. Postgres
// takes `0001-08-26T…Z` and rejects `0000-07-22T…Z` with "date/time field
// value out of range", and rejects the expanded form `-003450-…Z` outright
// with "time zone displacement out of range". So a cutoff must land in a
// positive four-digit year: today that is ~739,600 days, and the margin only
// grows as the clock advances. 700,000 days is ~1,916 years, leaving roughly
// a century of headroom, far past any window a plan can mean.
export const RETENTION_WINDOW_MAX_DAYS = 700_000

export const isRepresentableWindowDays = (days: number): boolean =>
    Number.isFinite(days) && days >= 0 && days <= RETENTION_WINDOW_MAX_DAYS
