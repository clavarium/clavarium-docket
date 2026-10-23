#!/usr/bin/env node
/* THE WORKER'S SIDE OF DOCKET: what an agent, or a script, sees of the events
 * an application posted, and how it says what it did of each. One file, no
 * dependency but time.mjs beside it.
 *
 *   a command    `docket`, `docket done ID` (bin/docket.mjs imports this file)
 *   MCP          `node docket.mjs [--dir FOLDER]`: the same verbs as tools, over
 *                standard input and output (JSON-RPC 2.0, one message per line)
 *
 * An event waits until the worker says what it did of it: done, or failed and
 * why. Nothing else takes it out. The worker may also set itself reminders
 * (at a time, in a while, by a cron line), which the application's tick turns
 * into events when they come due.
 *
 * THE FOLDER (docs/protocol.md):
 *   events.jsonl     the application's: what happened
 *   acks.jsonl       the worker's: what it did of each event
 *   plans.jsonl      the worker's: the reminders it set, and took back
 *   plans-off.jsonl  the application's: the reminders the person took back
 */
import { appendFileSync, readFileSync, mkdirSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { zoneOf, isZone, parseWhen, parseIn, parseCron, nextCron, lastCron, wall } from './time.mjs';

export const VERSION = '0.1.0';
export const FOLDER = '.docket';
export const TEXT_MAX = 500;
export const NOTE_MAX = 1000;
export const DATA_MAX = 4096;
export const ID_SHOWN = 8;
/* A reminder is at most this far away. */
export const AHEAD_MAX_MS = 366 * 86_400_000;
export const PLANS_MAX = 100;
export const LISTED_MAX = 50;
export const WAKE = 'You have something to handle: run "docket".';

const NOT_SHOWN = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;
export const oneLine = (text, max) => String(text ?? '').replace(/\r/g, '').replace(NOT_SHOWN, '').replace(/\s+/g, ' ').trim().slice(0, max);
const parsed = (line) => { try { const j = JSON.parse(line); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; } };
/* The lines of one file of the folder: never through a link; one that does not parse is skipped. */
export function lines(file) {
    try { if (lstatSync(file).isSymbolicLink()) return []; return readFileSync(file, 'utf8').split('\n').filter(Boolean).map(parsed).filter(Boolean); } catch { return []; }
}
const isFolder = (path) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/* The folder: `dir`, else $DOCKET_DIR, else the nearest .docket from `from` up. */
export function findFolder({ dir, env = process.env, from = process.cwd() } = {}) {
    if (dir) return resolve(dir);
    if (env.DOCKET_DIR) return resolve(env.DOCKET_DIR);
    for (let at = resolve(from); ; at = dirname(at)) {
        if (isFolder(join(at, FOLDER))) return join(at, FOLDER);
        if (dirname(at) === at) return null;
    }
}

/* The id of the event a plan gives for the time it is due: the same every time it is reckoned. */
export const eventIdOf = (plan, due) => createHash('sha256').update(`${plan}\n${due}`).digest('hex').slice(0, 32);

/* EVERYTHING IN THE FOLDER, as both sides see it. `now`: milliseconds. */
export function state(dir, { now = Date.now() } = {}) {
    /* An event posted twice (two sides ticked at once) is one: the first. */
    const seen = new Set();
    const events = lines(join(dir, 'events.jsonl')).filter((e) => typeof e.id === 'string' && e.id && !seen.has(e.id) && seen.add(e.id));
    const acks = new Map();
    for (const a of lines(join(dir, 'acks.jsonl'))) {
        if ((a.kind === 'done' || a.kind === 'failed') && typeof a.event === 'string' && !acks.has(a.event)) acks.set(a.event, { kind: a.kind, note: oneLine(a.note, NOTE_MAX), at: String(a.at ?? '') });
    }
    const off = new Map();
    for (const o of [...lines(join(dir, 'plans.jsonl')).filter((x) => x.kind === 'cancel').map((x) => ({ ...x, by: 'worker' })), ...lines(join(dir, 'plans-off.jsonl')).map((x) => ({ ...x, by: 'person' }))]) {
        if (typeof o.plan === 'string' && !off.has(o.plan)) off.set(o.plan, { at: String(o.at ?? ''), by: o.by });
    }
    const plans = lines(join(dir, 'plans.jsonl')).filter((p) => p.kind === 'plan' && typeof p.id === 'string').map((p) => {
        const tz = isZone(p.tz) ? p.tz : 'UTC';
        const plan = { id: p.id, set: String(p.at ?? ''), text: oneLine(p.text, TEXT_MAX), tz, ...(off.has(p.id) ? { off: off.get(p.id) } : {}) };
        if (typeof p.cron === 'string') { const c = parseCron(p.cron); if (!c) return null; plan.cron = p.cron; plan.next = off.has(p.id) ? null : nextCron(c, now - 1, tz); }
        else { const due = Date.parse(p.due); if (!Number.isFinite(due)) return null; plan.due = due; plan.next = off.has(p.id) ? null : due; }
        return plan;
    }).filter(Boolean);
    const all = events.map((e) => ({ id: e.id, at: String(e.at ?? ''), from: oneLine(e.from, 40), kind: oneLine(e.kind, 40), text: oneLine(e.text, TEXT_MAX),
        ...(e.data && typeof e.data === 'object' && !Array.isArray(e.data) ? { data: e.data } : {}), ...(typeof e.plan === 'string' ? { plan: e.plan, due: String(e.due ?? '') } : {}),
        ...(e.late ? { late: true } : {}), state: acks.get(e.id)?.kind ?? 'waiting', ...(acks.has(e.id) ? { ack: acks.get(e.id) } : {}) }));
    return { events: all, plans, waiting: all.filter((e) => e.state === 'waiting').length };
}

/* An id given whole or by its first characters: the one it names, or why not. */
function pick(list, given, what) {
    const id = oneLine(given, 100).replace(/^\[|\]$/g, '');
    if (id.length < ID_SHOWN) throw new Error(`give the id of the ${what}, as "docket" shows it (${ID_SHOWN} characters at least)`);
    const found = list.filter((x) => x.id.startsWith(id));
    if (found.length === 0) throw new Error(`no ${what} has the id ${id}`);
    if (found.length > 1) throw new Error(`several ${what}s start with ${id}: give more of it`);
    return found[0];
}
const stamp = (t, tz) => { const w = wall(t, tz); const p = (n) => String(n).padStart(2, '0'); return `${w.year}-${p(w.month)}-${p(w.day)} ${p(w.hour)}:${p(w.minute)} (${tz})`; };

/* THE VERBS, on one folder. */
export function verbs(dir, { env = process.env, now = () => Date.now() } = {}) {
    const write = (file, entry) => { mkdirSync(dir, { recursive: true }); const id = randomUUID(); appendFileSync(join(dir, file), `${JSON.stringify({ id, at: new Date(now()).toISOString(), ...entry })}\n`); return id; };
    const ack = (kind, given, note) => {
        const s = state(dir, { now: now() });
        const event = pick(s.events, given, 'event');
        if (event.state !== 'waiting') throw new Error(`that event was said ${event.state} already`);
        write('acks.jsonl', { kind, event: event.id, note: oneLine(note, NOTE_MAX) });
        return event;
    };
    return {
        list() {
            const s = state(dir, { now: now() });
            const waiting = s.events.filter((e) => e.state === 'waiting');
            const plans = s.plans.filter((p) => !p.off && p.next !== null && !(p.due !== undefined && s.events.some((e) => e.plan === p.id)));
            const said = [];
            if (waiting.length === 0) said.push('Nothing waits.');
            else {
                said.push(`Waiting (${waiting.length}), oldest first; say what you did of each: docket done ID, or docket failed ID "why".`);
                const tz = zoneOf(env, dir);
                const when = (e) => (Number.isFinite(Date.parse(e.at)) ? stamp(Date.parse(e.at), tz).replace(/ \(.*\)$/, '') : '?');
                for (const e of waiting.slice(0, LISTED_MAX)) said.push(`  [${e.id.slice(0, ID_SHOWN)}] ${when(e)} ${e.from}/${e.kind}${e.late ? ' (late)' : ''}: ${e.text}${e.data ? `\n      data: ${JSON.stringify(e.data).slice(0, 500)}` : ''}`);
                if (waiting.length > LISTED_MAX) said.push(`  ... and ${waiting.length - LISTED_MAX} more`);
            }
            if (plans.length) {
                said.push(`Your reminders (${plans.length}); take one back with docket cancel ID:`);
                for (const p of plans) said.push(`  [${p.id.slice(0, ID_SHOWN)}] ${p.cron ? `"${p.cron}", next ${stamp(p.next, p.tz)}` : stamp(p.next, p.tz)}: ${p.text}`);
            }
            return said.join('\n');
        },
        done(id, note) { const e = ack('done', id, note); return `Done: ${e.text}`; },
        failed(id, why) {
            if (!oneLine(why, NOTE_MAX)) throw new Error('say why it could not be done');
            const e = ack('failed', id, why);
            return `Said failed: ${e.text}. The person is told.`;
        },
        /* { at } or { in } or { cron }, and the text the reminder will say. */
        remind({ at, in: after, cron, text } = {}) {
            const said = oneLine(text, TEXT_MAX);
            if (!said) throw new Error('say what the reminder is for');
            const given = [at, after, cron].filter((x) => x !== undefined && x !== null && x !== '').length;
            if (given !== 1) throw new Error('give one of: --at "2026-10-23 09:00", --in 2h, --cron "0 9 * * 1"');
            const s = state(dir, { now: now() });
            if (s.plans.filter((p) => !p.off && p.next !== null).length >= PLANS_MAX) throw new Error(`${PLANS_MAX} reminders at most: take one back first`);
            const tz = zoneOf(env, dir);
            if (cron) {
                const c = parseCron(cron);
                if (!c) throw new Error('a cron line is five fields: minute hour day month weekday ("0 9 * * 1": Mondays at 9:00)');
                const next = nextCron(c, now(), tz);
                if (next === null) throw new Error('that cron line never comes within a year');
                const id = write('plans.jsonl', { kind: 'plan', cron: String(cron).trim().split(/\s+/).join(' '), tz, text: said });
                return `Set [${id.slice(0, ID_SHOWN)}]: "${String(cron).trim()}", next ${stamp(next, tz)}.`;
            }
            const due = at ? parseWhen(at, tz) : (() => { const ms = parseIn(after); return ms === null ? null : now() + ms; })();
            if (due === null) throw new Error(at ? 'a time is "2026-10-23 09:00" (date, then hour)' : 'a delay is a number then m, h or d: 45m, 2h, 3d');
            if (due <= now()) throw new Error(`that time has passed: it is ${stamp(now(), tz)} now`);
            if (due - now() > AHEAD_MAX_MS) throw new Error('a reminder is at most a year away');
            const id = write('plans.jsonl', { kind: 'plan', due: new Date(due).toISOString(), tz, text: said });
            return `Set [${id.slice(0, ID_SHOWN)}]: ${stamp(due, tz)}.`;
        },
        cancel(id) {
            const s = state(dir, { now: now() });
            const plan = pick(s.plans, id, 'reminder');
            if (plan.off) return 'It was taken back already.';
            write('plans.jsonl', { kind: 'cancel', plan: plan.id });
            return `Taken back: ${plan.text}`;
        },
        /* Posts an event for each reminder that came due and was not posted yet. */
        tick() { return tick(dir, { now: now() }).length; },
    };
}

/* REMINDERS BECOME EVENTS: once per time each is due. Written to events.jsonl, as the application posts:
   whichever side ticks, an event already there (by its id) is not posted again. */
export function tick(dir, { now = Date.now() } = {}) {
    const s = state(dir, { now });
    const have = new Set(s.events.map((e) => e.id));
    const posted = [];
    for (const p of s.plans) {
        if (p.off) continue;
        let due = null;
        if (p.cron) {
            const c = parseCron(p.cron);
            const last = s.events.filter((e) => e.plan === p.id).map((e) => Date.parse(e.due)).filter(Number.isFinite).sort((a, b) => a - b).at(-1);
            /* Since the last one posted, or since it was set: the last time it was due (one missed more than once is posted once). */
            const since = last ?? (Date.parse(p.set) || now) - 1;
            due = lastCron(c, since, now, p.tz);
        } else if (p.due <= now) due = p.due;
        if (due === null) continue;
        const id = eventIdOf(p.id, new Date(due).toISOString());
        if (have.has(id)) continue;
        const event = { id, at: new Date(now).toISOString(), from: 'docket', kind: 'reminder', text: p.text, plan: p.id, due: new Date(due).toISOString(), ...(now - due > 5 * 60_000 ? { late: true } : {}) };
        mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, 'events.jsonl'), `${JSON.stringify(event)}\n`);
        have.add(id); posted.push(event);
    }
    return posted;
}

/* ---- MCP ---- */
export const TOOLS = [
    { name: 'list', description: 'What waits for you, oldest first, each with its id; then the reminders you set. Say what you did of each event with done or failed.', inputSchema: { type: 'object', properties: {} } },
    { name: 'done', description: 'Say an event is handled.', inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'the id, or its first 8 characters' }, note: { type: 'string' } }, required: ['id'] } },
    { name: 'failed', description: 'Say an event could not be handled, and why: the person is told.', inputSchema: { type: 'object', properties: { id: { type: 'string' }, why: { type: 'string' } }, required: ['id', 'why'] } },
    { name: 'remind', description: 'Set yourself a reminder: at a time ("2026-10-23 09:00"), in a while ("2h", "3d"), or by a cron line ("0 9 * * 1"). It comes as an event when due.', inputSchema: { type: 'object', properties: { at: { type: 'string' }, in: { type: 'string' }, cron: { type: 'string' }, text: { type: 'string' } }, required: ['text'] } },
    { name: 'cancel', description: 'Take back a reminder you set.', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];
export function serve(dir, { input = process.stdin, output = process.stdout, env = process.env } = {}) {
    const v = verbs(dir, { env });
    const reply = (id, result, error) => output.write(`${JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) })}\n`);
    const rl = createInterface({ input });
    rl.on('line', (line) => {
        const m = parsed(line);
        if (!m || m.id === undefined) return;
        if (m.method === 'initialize') return reply(m.id, { protocolVersion: m.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'docket', version: VERSION } });
        if (m.method === 'tools/list') return reply(m.id, { tools: TOOLS });
        if (m.method === 'tools/call') {
            const { name, arguments: a = {} } = m.params ?? {};
            try {
                const text = name === 'list' ? v.list() : name === 'done' ? v.done(a.id, a.note) : name === 'failed' ? v.failed(a.id, a.why)
                    : name === 'remind' ? v.remind({ at: a.at, in: a.in, cron: a.cron, text: a.text }) : name === 'cancel' ? v.cancel(a.id) : null;
                if (text === null) return reply(m.id, undefined, { code: -32601, message: `no tool ${name}` });
                return reply(m.id, { content: [{ type: 'text', text }] });
            } catch (error) { return reply(m.id, { content: [{ type: 'text', text: `Not done: ${error.message}.` }], isError: true }); }
        }
        if (m.method === 'ping') return reply(m.id, {});
        return reply(m.id, undefined, { code: -32601, message: `no method ${m.method}` });
    });
    return rl;
}

const HERE = fileURLToPath(import.meta.url);
const main = (() => { try { return realpathSync(process.argv[1] ?? '') === realpathSync(HERE); } catch { return false; } })();
if (main) {
    const at = process.argv.indexOf('--dir');
    const dir = findFolder({ dir: at >= 0 ? process.argv[at + 1] : undefined });
    if (!dir) { process.stderr.write(`No ${FOLDER} folder: give --dir FOLDER.\n`); process.exit(2); }
    serve(dir);
}
