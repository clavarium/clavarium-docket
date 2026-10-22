# The protocol

Docket is three small things that agree on one folder, as Parley does: a
command and an MCP server for whoever does the work (an agent, a script), and
a library for the application that posts events.

## The folder

| File | Written by | What it holds |
|---|---|---|
| `events.jsonl` | the application | what happened, one event per line |
| `acks.jsonl` | the worker | what it did of each event: done, or failed and why |
| `plans.jsonl` | the worker | the reminders it set itself, and those it took back |
| `plans-off.jsonl` | the application | the reminders the person took back |
| `zone` | the application | the person's time zone, one IANA name (optional) |

Every `.jsonl` file only grows: nothing is edited, nothing is deleted. Each has one
writer. There is no address, no port and no key: whoever can read and write
the folder is a side.

The command finds the folder as git finds a repository: `--dir`, else
`$DOCKET_DIR`, else the nearest `.docket` from where it stands.

## An event

    {id, at, from, kind, text, data?, plan?, due?}

`from` names who posted it (`clavarium`, `mail`, `docket` for a reminder),
`kind` what it is (`arrival`, `call`, `clock`, `reminder`, any word), `text`
one line a person would write (500 characters), `data` a small object for a
program (4 KB once written). A reminder carries the `plan` it came from and
the time it was `due`.

An event WAITS until the worker says what it did of it. Nothing else takes it
out: an event told and never acknowledged is told again (when, and how
often, is the application's business).

## What the worker can do

| Command | MCP tool | It writes | It says |
|---|---|---|---|
| `docket` | `list()` | nothing | the events that wait, oldest first, each with its id; then the reminders set |
| `docket done ID [NOTE]` | `done(id, note?)` | `{kind:"done", event, note}` | at once |
| `docket failed ID WHY` | `failed(id, why)` | `{kind:"failed", event, note}` | at once; the application tells the person |
| `docket remind --at WHEN TEXT` | `remind({at, text})` | `{kind:"plan", id, at: WHEN, text}` | the time it is due, as understood |
| `docket remind --in 2h TEXT` | `remind({in, text})` | the same, `at` reckoned now | the same |
| `docket remind --cron "M H D M W" TEXT` | `remind({cron, text})` | `{kind:"plan", id, cron, tz, text}` | the next time it is due |
| `docket cancel PLAN` | `cancel(plan)` | `{kind:"cancel", plan}` | at once |
| `docket tick` | none | events, for the reminders due | how many; for a machine with no application, from its own cron |

ID and PLAN are given whole, or by their first 8 characters or more. WHEN is
a date and a time, `2026-10-23 09:00`, in the time zone of the folder (below),
or with its own offset. `--in` takes minutes, hours or days: `45m`, `2h`,
`3d`. A cron line is five fields (minute, hour, day of the month, month, day of
the week; `*`, lists, ranges and steps). A reminder is at most a year away; a
plan by cron says its next time each time it is listed.

`acks.jsonl` and `plans.jsonl` lines also carry `id` and `at` (the time,
ISO 8601). An event acknowledged twice keeps the first. Exit codes of the
command: 0 done, 1 refused, 2 no folder, 64 not understood.

## Time

A folder's time zone is `$DOCKET_TZ` (an IANA name, `Europe/Paris`), else
the one the application wrote in its `zone` file (`zone(tz)`: the person's,
since a machine often runs in UTC), else the machine's. It is written into each plan, so that a cron line keeps meaning
what it meant where it was set.

## Reminders become events

`tick(now)` (the application's, every few seconds; `docket tick` without one)
posts an event for each reminder that came due and was not posted yet: once
per time it is due (its id says which), `from: "docket"`, `kind: "reminder"`,
the plan's text. One missed while nothing ran is posted late, once, saying
so; a cron plan missed more than once is posted once, for the last time it
was due.

## The application's side

| Action | Gives |
|---|---|
| `post({from, kind, text, data?})` | the event, written |
| `read()` | `events` (each with `state`: `waiting`, `done` or `failed`, and its `ack`), `plans` (each with `next`, or `off`), `waiting` (how many) |
| `tick(now?)` | the events it posted |
| `cancel(plan)` | the plan taken back, by the person |
| `zone(tz)` | the folder's time zone written |
| `listen({every})` | events of its own: `acked` (`{event, ack}`), `planned` (`{plan}`), `cancelled` (`{plan}`) |

`WAKE` is one line the application may type to a worker that waits at a
prompt: `You have something to handle: run "docket".` What an event says is
never on that line.

## What each side must not trust

What the worker wrote (its notes, its reminders' text) is text chosen by a
program: bounded, cleaned of what a screen obeys, given as text. A line that
does not parse is skipped. A link where a file should be is not followed.
