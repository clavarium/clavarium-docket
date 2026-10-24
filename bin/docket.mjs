#!/usr/bin/env node
/* THE COMMAND: Docket's verbs for any worker that can run a command. It writes
 * the same files as the MCP server (server/docket.mjs).
 *
 *   docket | done | failed | remind | cancel | tick | --help | --version
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verbs, findFolder, FOLDER, VERSION } from '../server/docket.mjs';

export const HELP = `docket: the events an application posted for you, and what you did of each.

  docket                               what waits, oldest first, each with its id; then your reminders
  docket done ID ["note"]              handled
  docket failed ID "why"               could not be handled: say why; the person is told
  docket remind --at "2026-10-23 09:00" "text"
  docket remind --in 2h "text"         also 45m, 3d
  docket remind --cron "0 9 * * 1" "text"
                                       set yourself a reminder: it comes as an event when due
  docket cancel ID                     take back a reminder you set
  docket tick                          post the reminders due (for a machine with no application)

ID: whole, or its first 8 characters. Times are in $DOCKET_TZ, else the machine's time zone.
An event waits until you say done or failed: one never acknowledged is given to you again.
Keep reminder texts and done notes short (a few words): the person sees them.
The folder used is --dir FOLDER, else $DOCKET_DIR, else the nearest ${FOLDER} folder from here up.
docket ${VERSION}`;

/* Runs one command line. Resolves with { code, out, err }: nothing is printed here. */
export function run(argv, { env = process.env, cwd = process.cwd(), now } = {}) {
    const args = [...argv];
    let dir;
    const at = args.indexOf('--dir');
    if (at >= 0) { dir = args[at + 1]; if (!dir) return { code: 64, out: '', err: '--dir needs a folder.\n' }; args.splice(at, 2); }
    const [verb = 'list', ...rest] = args;
    if (verb === '--help' || verb === '-h' || verb === 'help') return { code: 0, out: `${HELP}\n`, err: '' };
    if (verb === '--version') return { code: 0, out: `${VERSION}\n`, err: '' };
    if (!['list', 'done', 'failed', 'remind', 'cancel', 'tick'].includes(verb)) return { code: 64, out: '', err: `Unknown: ${verb}. Run "docket --help".\n` };
    const folder = findFolder({ dir, env, from: cwd });
    if (!folder) return { code: 2, out: '', err: `No ${FOLDER} folder here or above. Run it from your work folder, or give --dir FOLDER.\n` };
    const v = verbs(folder, { env, ...(now ? { now } : {}) });
    const flag = (name) => { const i = rest.indexOf(name); if (i < 0) return undefined; const value = rest[i + 1]; rest.splice(i, 2); return value ?? ''; };
    try {
        let said;
        if (verb === 'list') { if (rest.length) return { code: 64, out: '', err: 'docket alone lists; it takes nothing else.\n' }; said = v.list(); }
        else if (verb === 'done') said = v.done(rest[0], rest.slice(1).join(' '));
        else if (verb === 'failed') said = v.failed(rest[0], rest.slice(1).join(' '));
        else if (verb === 'remind') { const when = { at: flag('--at'), in: flag('--in'), cron: flag('--cron') }; said = v.remind({ ...when, text: rest.join(' ') }); }
        else if (verb === 'cancel') said = v.cancel(rest[0]);
        else { const n = v.tick(); said = n === 0 ? 'Nothing came due.' : `${n} reminder${n === 1 ? '' : 's'} came due.`; }
        return { code: 0, out: `${said}\n`, err: '' };
    } catch (error) {
        return { code: 1, out: '', err: `Not done: ${error.message}. Run "docket --help".\n` };
    }
}

const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (main) {
    const r = run(process.argv.slice(2));
    if (r.out) process.stdout.write(r.out);
    if (r.err) process.stderr.write(r.err);
    process.exitCode = r.code;
}
