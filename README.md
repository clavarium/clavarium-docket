# Clavarium Docket

Events that an AI agent, or a plain script, sees and acknowledges.

Something changed (a file arrived in a folder, a commit in a repository, a mail
in a mailbox): an application posts an event. Whoever does the work lists what
waits, handles it, and says so:

    docket              # what waits
    docket done <id>    # handled
    docket failed <id>  # could not: tell the owner

An MCP server gives the same three verbs to an AI agent; the command line gives
them to a person or a script. Nothing is lost: an event delivered but never
acknowledged is delivered again.

A sibling of [Clavarium Parley](https://github.com/clavarium/clavarium-parley),
built the same way, universal (nothing in it is specific to Clavarium).

A worker may also set itself reminders, which come as events when due:

    docket remind --at "2026-10-23 09:00" "call the client back"
    docket remind --in 2h "check the build"
    docket remind --cron "0 9 * * 1" "Monday review"

The application's side (`clavarium-docket/host`) posts events, turns the
reminders that came due into events (`tick`), and is told what the worker
did. When to tell the worker, and how often again, is the application's
business. See [docs/protocol.md](docs/protocol.md).

No dependency; Node 22 or later.

**Status:** first version (0.1), tried with a real coding agent in Clavarium: a reminder it set itself woke it on time, and it said it done.

License: MIT.
