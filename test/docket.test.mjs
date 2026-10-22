import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Docket, WAKE } from '../host/docket-host.mjs';
import { run, HELP } from '../bin/docket.mjs';
import { findFolder, eventIdOf, VERSION, TOOLS } from '../server/docket.mjs';
import { parseCron, nextCron, parseWhen, parseIn, moment, zoneOf } from '../server/time.mjs';

const SERVER = fileURLToPath(new URL('../server/docket.mjs', import.meta.url));
const folder = (t) => { const dir = mkdtempSync(join(tmpdir(), 'docket-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; };
const PARIS = { DOCKET_TZ: 'Europe/Paris', DOCKET_DIR: '' };
const T0 = Date.parse('2026-10-22T10:00:00.000Z');   /* 12:00 in Paris */

test('time: a wall clock in a time zone, a cron line, when it is next due, across the clock changes', () => {
    const tz = 'Europe/Paris';
    assert.equal(new Date(parseWhen('2026-10-23 09:00', tz)).toISOString(), '2026-10-23T07:00:00.000Z', 'summer time');
    assert.equal(new Date(parseWhen('2026-11-03 09:00', tz)).toISOString(), '2026-11-03T08:00:00.000Z', 'winter time');
    assert.equal(new Date(parseWhen('2026-10-23T09:00Z', tz)).toISOString(), '2026-10-23T09:00:00.000Z', 'its own offset');
    assert.equal(new Date(parseWhen('2026-10-23 09:00+05:30', tz)).toISOString(), '2026-10-23T03:30:00.000Z');
    for (const bad of ['tomorrow', '2026-02-30 10:00', '2026-10-23 25:00', '23/10/2026']) assert.equal(parseWhen(bad, tz), null, bad);
    assert.deepEqual([parseIn('45m'), parseIn('2h'), parseIn('3d'), parseIn('0h'), parseIn('soon')], [2_700_000, 7_200_000, 259_200_000, null, null]);
    const monday = parseCron('0 9 * * 1');
    const next = (c, from) => { const n = nextCron(c, from, tz); return n === null ? null : new Date(n).toISOString(); };
    assert.equal(next(monday, T0), '2026-10-26T08:00:00.000Z', 'the Monday after the clocks went back');
    assert.equal(next(parseCron('30 0 * * *'), parseWhen('2026-03-28 00:40', tz)), '2026-03-28T23:30:00.000Z', 'the night the clocks go forward');
    assert.equal(next(parseCron('0 12 1 * *'), T0), '2026-11-01T11:00:00.000Z');
    assert.equal(next(parseCron('*/15 8-18 * * 1-5'), T0), '2026-10-22T10:15:00.000Z');
    assert.equal(next(parseCron('0 9 29 2 *'), T0), null, 'none within a year');
    assert.equal(next(parseCron('0 9 13 * 5'), T0), '2026-10-23T07:00:00.000Z', 'day of month OR day of week, as cron');
    for (const bad of ['* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', 'a * * * *', '*/0 * * * *']) assert.equal(parseCron(bad), null, bad);
    assert.equal(zoneOf({ DOCKET_TZ: 'Europe/Paris' }), 'Europe/Paris');
    assert.equal(zoneOf({ DOCKET_TZ: 'Mars/Olympus' }), zoneOf({}), 'not a zone: the machine\'s');
    assert.equal(new Date(moment({ year: 2026, month: 7, day: 1, hour: 12 }, 'UTC')).toISOString(), '2026-07-01T12:00:00.000Z');
});

test('an event waits until the worker says what it did of it; the application is told; one said already stays as said', async (t) => {
    const dir = join(folder(t), '.docket');
    const told = [];
    let now = T0;
    const app = new Docket(dir, { on: (e) => told.push(e), now: () => now });
    const stop = app.listen({ every: 20 });
    t.after(stop);
    const e = app.post({ from: 'clavarium', kind: 'arrival', text: '2 files\nin the inbox', data: { files: ['a.pdf', 'b.pdf'] } });
    assert.equal(e.text, '2 files in the inbox', 'one line');
    assert.throws(() => app.post({ text: ' ' }), /says what happened/);
    assert.throws(() => app.post({ text: 'x', data: 'big' }), /data/);
    assert.throws(() => app.post({ text: 'x', data: { x: 'y'.repeat(5000) } }), /data/);
    const cwd = join(dir, '..');
    let r = run([], { env: PARIS, cwd, now: () => now });
    assert.equal(r.code, 0);
    assert.match(r.out, new RegExp(`^Waiting \\(1\\).*\\n  \\[${e.id.slice(0, 8)}\\] 2026-10-22 12:00 clavarium/arrival: 2 files in the inbox\\n      data: \\{"files":\\["a.pdf","b.pdf"\\]\\}\\n$`));
    assert.equal(app.read().waiting, 1);
    assert.equal(run(['done', e.id.slice(0, 7)], { env: PARIS, cwd }).code, 1, 'too short an id');
    r = run(['done', e.id.slice(0, 8), 'filed', 'both'], { env: PARIS, cwd, now: () => now });
    assert.deepEqual([r.code, r.out], [0, 'Done: 2 files in the inbox\n']);
    assert.deepEqual(app.read().events[0].ack, { kind: 'done', note: 'filed both', at: new Date(now).toISOString() });
    assert.equal(run(['failed', e.id, 'too late'], { env: PARIS, cwd }).err, 'Not done: that event was said done already. Run "docket --help".\n');
    assert.equal(run([], { env: PARIS, cwd }).out, 'Nothing waits.\n');
    const f = app.post({ from: 'clavarium', kind: 'call', text: 'deploy' });
    assert.match(run(['failed', f.id], { env: PARIS, cwd }).err, /say why/);
    assert.equal(run(['failed', f.id, 'the server', 'is down'], { env: PARIS, cwd }).out, 'Said failed: deploy. The person is told.\n');
    await new Promise((r2) => setTimeout(r2, 100));
    assert.deepEqual(told.filter((x) => x.type === 'acked').map((x) => [x.event.id, x.ack.kind, x.ack.note]), [[e.id, 'done', 'filed both'], [f.id, 'failed', 'the server is down']]);
    assert.equal(WAKE, 'You have something to handle: run "docket".');
});

test('the worker sets itself reminders; each becomes an event once each time it is due; one missed is posted late, once', (t) => {
    const dir = join(folder(t), '.docket'); mkdirSync(dir);
    const cwd = join(dir, '..');
    let now = T0;
    const app = new Docket(dir, { now: () => now });
    const say = (...args) => run(args, { env: PARIS, cwd, now: () => now });
    assert.equal(say('remind', '--in', '2h', 'call', 'the', 'client').out.replace(/\[\w+\]/, '[id]'), 'Set [id]: 2026-10-22 14:00 (Europe/Paris).\n');
    assert.equal(say('remind', '--cron', '0 9 * * 1', 'Monday review').out.replace(/\[\w+\]/, '[id]'), 'Set [id]: "0 9 * * 1", next 2026-10-26 09:00 (Europe/Paris).\n');
    assert.match(say('remind', '--at', '2026-10-22 11:00', 'past').err, /has passed: it is 2026-10-22 12:00/);
    assert.match(say('remind', '--at', '2028-01-01 10:00', 'far').err, /at most a year/);
    assert.match(say('remind', '--in', '2h', '--cron', '* * * * *', 'both').err, /give one of/);
    assert.match(say('remind', '--in', '2h').err, /what the reminder is for/);
    assert.match(say('remind', '--cron', '0 9 * *', 'x').err, /five fields/);
    assert.match(say().out, /Your reminders \(2\)/);
    assert.deepEqual(app.read().plans.map((p) => [p.text, new Date(p.next).toISOString(), p.tz]), [['call the client', '2026-10-22T12:00:00.000Z', 'Europe/Paris'], ['Monday review', '2026-10-26T08:00:00.000Z', 'Europe/Paris']]);
    assert.deepEqual(app.tick(), [], 'nothing due yet');
    now = Date.parse('2026-10-22T12:00:30.000Z');
    let posted = app.tick();
    assert.deepEqual(posted.map((e) => [e.from, e.kind, e.text, e.due, e.late ?? false]), [['docket', 'reminder', 'call the client', '2026-10-22T12:00:00.000Z', false]]);
    assert.deepEqual(app.tick(), [], 'once');
    assert.equal(say('tick').out, 'Nothing came due.\n', 'the worker\'s tick agrees: posted already');
    assert.doesNotMatch(say().out.split('Your reminders')[1], /call the client/, 'a reminder that came is listed as an event, not as a reminder');
    assert.match(say().out, /Your reminders \(1\)/);
    /* Nothing ran for two weeks: the Monday review is posted once, for the last Monday, late. */
    now = Date.parse('2026-11-04T10:00:00.000Z');
    posted = app.tick();
    assert.deepEqual(posted.map((e) => [e.text, e.due, e.late]), [['Monday review', '2026-11-02T08:00:00.000Z', true]]);
    assert.equal(posted[0].id, eventIdOf(posted[0].plan, posted[0].due));
    now = Date.parse('2026-11-09T08:00:10.000Z');
    assert.deepEqual(app.tick().map((e) => e.due), ['2026-11-09T08:00:00.000Z']);
    /* Taken back: by the worker, or by the person; it comes no more. */
    const plan = app.read().plans.find((p) => p.cron);
    assert.equal(say('cancel', plan.id.slice(0, 8)).out, 'Taken back: Monday review\n');
    now = Date.parse('2026-11-16T08:00:10.000Z');
    assert.deepEqual(app.tick(), []);
    say('remind', '--cron', '0 * * * *', 'hourly');
    const hourly = app.read().plans.find((p) => p.text === 'hourly');
    assert.equal(app.cancel(hourly.id).plans.find((p) => p.id === hourly.id).off.by, 'person');
    now += 3 * 3_600_000;
    assert.deepEqual(app.tick(), []);
    assert.throws(() => app.cancel('nope'), /No such reminder/);
});

test('the command: found from where it stands, said in a few lines, refused with a reason; a link is never followed', (t) => {
    const home = folder(t);
    assert.equal(run([], { env: PARIS, cwd: home }).code, 2);
    mkdirSync(join(home, '.docket')); mkdirSync(join(home, 'a', 'b'), { recursive: true });
    assert.equal(findFolder({ from: join(home, 'a', 'b'), env: {} }), join(home, '.docket'));
    assert.equal(run(['frobnicate'], { env: PARIS, cwd: home }).code, 64);
    assert.equal(run(['--version'], { env: PARIS, cwd: home }).out, `${VERSION}\n`);
    assert.match(HELP, /docket done ID/); assert.match(HELP, /docket remind --cron/);
    assert.equal(run(['list', 'x'], { env: PARIS, cwd: home }).code, 64);
    /* What the worker wrote is not trusted: a line that does not parse is skipped, a link is not read. */
    const dir = join(home, '.docket');
    appendFileSync(join(dir, 'events.jsonl'), 'not json\n{"id":"e9","at":"2026-10-22T10:00:00Z","text":"a\\u0007b"}\n');
    assert.match(run([], { env: PARIS, cwd: home }).out, /: ab\n?$/);
    const elsewhere = join(folder(t), 'acks.jsonl');
    writeFileSync(elsewhere, '{"kind":"done","event":"e9"}\n');
    symlinkSync(elsewhere, join(dir, 'acks.jsonl'));
    assert.equal(new Docket(dir).read().waiting, 1, 'through a link: nothing read');
});

test('the same verbs as MCP tools', async (t) => {
    const dir = join(folder(t), '.docket'); mkdirSync(dir);
    const app = new Docket(dir);
    const e = app.post({ from: 'x', kind: 'y', text: 'z' });
    const child = spawn(process.execPath, [SERVER, '--dir', dir], { env: { ...process.env, ...PARIS } });
    t.after(() => child.kill());
    const replies = [];
    let rest = '';
    child.stdout.on('data', (d) => { rest += d; const parts = rest.split('\n'); rest = parts.pop(); for (const p of parts) if (p) replies.push(JSON.parse(p)); });
    const ask = async (id, method, params) => { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`); const end = Date.now() + 5000; while (!replies.some((r) => r.id === id)) { if (Date.now() > end) throw new Error(`no reply to ${method}`); await new Promise((r) => setTimeout(r, 20)); } return replies.find((r) => r.id === id); };
    assert.equal((await ask(1, 'initialize', {})).result.serverInfo.name, 'docket');
    assert.deepEqual((await ask(2, 'tools/list')).result.tools.map((x) => x.name), TOOLS.map((x) => x.name));
    assert.match((await ask(3, 'tools/call', { name: 'list', arguments: {} })).result.content[0].text, /Waiting \(1\)/);
    assert.equal((await ask(4, 'tools/call', { name: 'done', arguments: { id: e.id } })).result.content[0].text, 'Done: z');
    const refused = (await ask(5, 'tools/call', { name: 'remind', arguments: { text: 'x' } })).result;
    assert.equal(refused.isError, true);
    assert.match((await ask(6, 'tools/call', { name: 'remind', arguments: { in: '1h', text: 'later' } })).result.content[0].text, /^Set \[/);
    assert.equal(app.read().plans.length, 1);
});
