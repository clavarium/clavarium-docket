#!/usr/bin/env node
/* Clavarium Docket is not built yet: this version only keeps the name. It runs
 * nothing else, installs nothing and reaches no network. */
process.stderr.write('Clavarium Docket is not built yet.\n'
    + 'Events an AI agent or a script sees and acknowledges: list, done, failed.\n'
    + 'https://github.com/clavarium/clavarium-docket\n');
process.exitCode = 1;
