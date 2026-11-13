import { fork, type ChildProcess } from 'node:child_process';

import type {
  ReplicaCommand,
  ReplicaReady,
  ReplicaReply,
  ReplicaStopped,
} from './concurrency-protocol';

/** Bounded IPC for this stand only; no public/server endpoint is introduced. */
export class ConcurrencyProcess {
  private readonly child: ChildProcess;
  private sequence = 0;
  private readonly pending = new Map<
    number,
    {
      resolve: (data: unknown) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  readonly ready: Promise<ReplicaReady>;
  readonly exited: Promise<void>;

  constructor(endpoint: string) {
    if (!process.env.LOAD_REPLICA_PATH)
      throw new Error('Compiled test replica required.');
    this.child = fork(process.env.LOAD_REPLICA_PATH, [], {
      cwd: process.cwd(),
      env: { ...process.env, LOAD_PROVIDER_ENDPOINT: endpoint },
      execArgv: [],
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
    this.ready = this.waitFor<ReplicaReady>(0);
    this.child.on('message', (reply: ReplicaReply) => {
      const pending = this.pending.get(reply.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(reply.id);
      if (reply.ok) pending.resolve(reply.data);
      else pending.reject(new Error('Concurrency replica command failed.'));
    });
    this.child.on('error', () => this.fail());
    this.exited = new Promise((resolve) =>
      this.child.once('close', () => {
        this.fail();
        resolve();
      }),
    );
  }

  private fail() {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error('Concurrency replica exited unexpectedly.'));
    }
    this.pending.clear();
  }

  private waitFor<T>(id: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Concurrency replica response timed out.'));
      }, 20000);
      this.pending.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
    });
  }

  call<T>(command: ReplicaCommand): Promise<T> {
    if (!this.child.connected)
      return Promise.reject(new Error('Concurrency replica disconnected.'));
    const id = ++this.sequence;
    const response = this.waitFor<T>(id);
    this.child.send({ id, command }, (error) => {
      if (error) this.fail();
    });
    return response;
  }

  async stop(): Promise<ReplicaStopped> {
    const timeout = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    try {
      return await this.call<ReplicaStopped>({ kind: 'STOP' });
    } finally {
      await this.exited;
      clearTimeout(timeout);
    }
  }
}
