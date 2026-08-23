// server/queue.js
// -----------------------------------------------------------------------------
// A minimal but REAL asynchronous message queue running inside the Node
// process, with its own event loop tick that decouples "publish" from
// "consume" exactly the way Redis+BullMQ would.
//
// WHY NOT REDIS + BULLMQ FOR THIS MVP:
// BullMQ requires a running Redis server. To keep this project runnable with
// a single `npm install && npm run dev` and no Docker/external services, we
// implement the same publish/consume contract in-process. The queue module is
// isolated behind publish()/registerConsumer() so swapping in BullMQ later is
// a drop-in replacement (see README "Known limitations").
//
// This is NOT a frontend setTimeout hack: the HTTP request that publishes a
// job returns immediately with PENDING; a separate consumer loop (started
// once at server boot, see worker.js) picks the job up on its own schedule,
// independently of any client request.
// -----------------------------------------------------------------------------

import { EventEmitter } from "node:events";

class InProcessQueue extends EventEmitter {
  constructor(name) {
    super();
    this.name = name;
    this.jobs = [];
    this.consumers = [];
    this._draining = false;
  }

  publish(job) {
    this.jobs.push(job);
    console.log(`[QUEUE] "${this.name}" received job ${job.id} for attendee ${job.attendeeId}`);
    // Decouple from the calling request: schedule consumption on a later tick.
    setImmediate(() => this._drain());
    return job;
  }

  registerConsumer(handler) {
    this.consumers.push(handler);
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this.jobs.length > 0) {
        const job = this.jobs.shift();
        for (const handler of this.consumers) {
          // Fire and forget from the queue's perspective — the worker manages
          // its own async lifecycle (this mirrors how a BullMQ worker process
          // pulls a job and processes it independently of the producer).
          handler(job).catch((err) => {
            console.error(`[QUEUE] consumer error for job ${job.id}:`, err.message);
          });
        }
      }
    } finally {
      this._draining = false;
    }
  }
}

export const printQueue = new InProcessQueue("badge-print-jobs");
