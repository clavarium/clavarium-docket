/* THE APPLICATION'S SIDE OF DOCKET: it posts what happened, turns the
 * reminders that came due into events, and is told what the worker did.
 *
 * DOCKET ANNOUNCES, THE APPLICATION DECIDES. When to tell the worker that
 * something waits, how often to tell it again, whom to tell of a failure: the
 * application's business. WAKE is a line it may type.
 *
 *   events, to `on(event)`                 actions, called by the application
 *   acked      {event, ack}                post({from, kind, text, data})
 *   planned    {plan}                      read()
 *   cancelled  {plan}                      tick(now)
 *                                          cancel(plan)   (by the person)
 *
 * WHAT IS READ HERE WAS WRITTEN BY A WORKER: its notes and its reminders are
 * text chosen by a program, bounded and cleaned, handed over as text.
 */
import { appendFileSync, mkdirSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { state, tick, oneLine, TEXT_MAX, DATA_MAX, WAKE, VERSION, FOLDER } from '../server/docket.mjs';

export { WAKE, VERSION, FOLDER };

export class Docket {
    #dir; #on; #now;
    /* `on(event)`: told what the worker did (acked), set (planned) or took back (cancelled). `now()`: milliseconds. */
    constructor(dir, { on, now = () => Date.now() } = {}) { this.#dir = dir; this.#on = on; this.#now = now; }

    #tell(event) { try { this.#on?.(event); } catch { /* a hook that fails stops nothing */ } }
    #append(file, entry) { mkdirSync(this.#dir, { recursive: true }); appendFileSync(join(this.#dir, file), `${JSON.stringify(entry)}\n`); }

    /* Something happened: one event, waiting until the worker says what it did of it. */
    post({ from, kind, text, data } = {}) {
        const said = oneLine(text, TEXT_MAX);
        if (!said) throw new RangeError('An event says what happened.');
        const extra = data === undefined ? undefined : JSON.stringify(data);
        if (extra !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data) || extra.length > DATA_MAX)) throw new RangeError(`An event's data is an object of ${DATA_MAX} characters at most.`);
        const event = { id: randomUUID(), at: new Date(this.#now()).toISOString(), from: oneLine(from, 40) || 'app', kind: oneLine(kind, 40) || 'event', text: said, ...(extra === undefined ? {} : { data }) };
        this.#append('events.jsonl', event);
        return event;
    }

    /* Everything: the events (each with its state and ack), the reminders (each with when it is next due), how many wait. */
    read() { return state(this.#dir, { now: this.#now() }); }

    /* The reminders that came due, posted as events: once each time each is due. */
    tick(now = this.#now()) { return tick(this.#dir, { now }); }

    /* The person takes a reminder back. */
    cancel(plan) {
        const found = this.read().plans.find((p) => p.id === plan);
        if (!found) throw new RangeError('No such reminder.');
        if (found.off) return this.read();
        this.#append('plans-off.jsonl', { id: randomUUID(), at: new Date(this.#now()).toISOString(), plan: found.id });
        return this.read();
    }

    /* Starts announcing, FROM NOW ON, what the worker writes: acked, planned, cancelled. The files are
       looked at, nothing is pushed. Resolves with a function that stops it. */
    listen({ every = 2000 } = {}) {
        const size = (f) => { try { return lstatSync(join(this.#dir, f)).isSymbolicLink() ? 0 : statSync(join(this.#dir, f)).size; } catch { return 0; } };
        const known = () => { const s = this.read(); return { acks: new Set(s.events.filter((e) => e.ack).map((e) => e.id)), plans: new Set(s.plans.map((p) => p.id)), off: new Set(s.plans.filter((p) => p.off).map((p) => p.id)) }; };
        let was = known();
        let sizes = ['acks.jsonl', 'plans.jsonl', 'plans-off.jsonl'].map(size).join();
        const look = () => {
            const now = ['acks.jsonl', 'plans.jsonl', 'plans-off.jsonl'].map(size).join();
            if (now === sizes) return;
            sizes = now;
            const s = this.read();
            for (const e of s.events) if (e.ack && !was.acks.has(e.id)) this.#tell({ type: 'acked', event: e, ack: e.ack });
            for (const p of s.plans) {
                if (!was.plans.has(p.id)) this.#tell({ type: 'planned', plan: p });
                else if (p.off && !was.off.has(p.id)) this.#tell({ type: 'cancelled', plan: p });
            }
            was = known();
        };
        const timer = setInterval(look, every);
        timer.unref?.();
        return () => clearInterval(timer);
    }
}
