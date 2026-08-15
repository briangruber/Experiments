// The work queue.
//
// Generations are slow — three to five minutes for a shot — so nothing in this
// system can be a request/response. Work is queued, the browser subscribes to
// an event stream, and progress arrives as it happens.
//
// Concurrency is per *lane*. Shooting a scene has to be serial, because a shot
// may reference the one before it and a fan-out would race its own inputs.
// Company work has no such constraint: four character sheets can draw at once
// and there is no reason to make someone wait. So each job names a lane, and
// lanes run independently while jobs within a lane run in order.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';

export class Jobs extends EventEmitter {
  constructor({ lanes = { default: 3, shoot: 1, company: 3 } } = {}) {
    super();
    this.limits = lanes;
    this.running = new Map();
    this.queued = new Map();
    this.all = new Map();
  }

  add({ lane = 'default', label, detail = null, run }) {
    const job = {
      id: randomUUID().slice(0, 8),
      lane, label, detail,
      status: 'queued',
      logs: [],
      queuedAt: Date.now(),
      startedAt: null, endedAt: null,
      result: null, error: null,
    };
    this.all.set(job.id, job);
    if (!this.queued.has(lane)) this.queued.set(lane, []);
    this.queued.get(lane).push({ job, run });
    this.#emit(job);
    queueMicrotask(() => this.#pump(lane));
    return job;
  }

  #emit(job) {
    // The wire form deliberately omits `run` and trims logs: a job that has
    // printed two thousand lines should not push all of them on every tick.
    this.emit('job', {
      id: job.id, lane: job.lane, label: job.label, detail: job.detail,
      status: job.status, error: job.error, result: job.result,
      logs: job.logs.slice(-40),
      queuedAt: job.queuedAt, startedAt: job.startedAt, endedAt: job.endedAt,
    });
  }

  async #pump(lane) {
    const limit = this.limits[lane] ?? this.limits.default ?? 1;
    const active = this.running.get(lane) || 0;
    const queue = this.queued.get(lane) || [];
    if (active >= limit || !queue.length) return;

    const { job, run } = queue.shift();
    this.running.set(lane, active + 1);
    job.status = 'running';
    job.startedAt = Date.now();
    this.#emit(job);

    const log = (line) => {
      job.logs.push(String(line));
      this.#emit(job);
    };

    try {
      job.result = (await run({ log })) ?? null;
      job.status = 'done';
    } catch (err) {
      job.error = err.message;
      job.status = 'failed';
      log(`error: ${err.message}`);
    } finally {
      job.endedAt = Date.now();
      this.running.set(lane, (this.running.get(lane) || 1) - 1);
      this.#emit(job);
      queueMicrotask(() => this.#pump(lane));
    }
  }

  list() {
    return [...this.all.values()]
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .slice(0, 60)
      .map(({ id, lane, label, detail, status, error, logs, queuedAt, startedAt, endedAt, result }) =>
        ({ id, lane, label, detail, status, error, result, logs: logs.slice(-40), queuedAt, startedAt, endedAt }));
  }
}
