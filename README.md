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

**Status: not built yet.** The npm package only keeps the name.

License: MIT.
