import fs from 'node:fs/promises';
import path from 'node:path';
import { initialState, transition } from './core.mjs';
import { outboxTransition } from './outbox.mjs';
import { runtimeTransition } from './runtime-state.mjs';
import {acquireWriterGuard,abandonedMarker} from './writer-guard.mjs';
import {encodeJournal,replayJournal} from './journal-codec.mjs';
import {freezeState} from './state-reader.mjs';

/** Single-process, exclusive-writer journal. New records store checksummed state deltas.
 * A torn final line is ignored; committed interior corruption is refused.
 * Keep this directory outside every executor workspace. OS isolation is a host responsibility.
 */
export class JournalStore {
  #state; #persisted; #readCache; #file; #lock; #guard; #queue = Promise.resolve(); #closed = false; #closing;
  static async open(directory) {
    await fs.mkdir(directory, { recursive: true });
    directory=await fs.realpath(directory);
    const lockPath = path.join(directory, 'writer.lock'),store=new JournalStore();
    try {
      store.#guard=await acquireWriterGuard(path.join(directory,'writer.guard'));
      let lock;
      try {lock=await fs.open(lockPath,'wx');}
      catch(e) {
        if(e.code!=='EEXIST')throw e;
        if(!store.#guard)throw new Error('Writer lock exists. Verify the previous DSH process has stopped before recovering its lock.');
        let marker;try{marker=JSON.parse(await fs.readFile(lockPath,'utf8'));}catch(error){throw new Error('Malformed writer lock; manual recovery required',{cause:error});}
        if(!abandonedMarker(marker))throw new Error('Writer lock exists: legacy owner is still alive');
        await fs.unlink(lockPath);lock=await fs.open(lockPath,'wx');
      }
      store.#lock={handle:lock,path:lockPath};
      await lock.writeFile(JSON.stringify({pid:process.pid,started:new Date().toISOString(),...(store.#guard?{lockProtocol:'win32-file-v1'}:{})}));
      await lock.sync();
      const file = path.join(directory, 'state.jsonl');
      try { store.#file = await fs.open(file, 'r+'); }
      catch(e) { if(e.code !== 'ENOENT') throw e; store.#file = await fs.open(file, 'wx+'); }
      const state=await replayJournal(store.#file,initialState());
      store.#state = state; store.#persisted = state; return store;
    } catch(e) { await store.close(); throw e; }
  }
  snapshot() { return structuredClone(this.#state); }
  // Never expose mutable durable state, or carry a cached view across a commit.
  readSnapshot() { return this.#readCache ??= freezeState(this.snapshot()); }
  dispatch(actor, command) {
    const frozenActor = structuredClone(actor), frozenCommand = structuredClone(command);
    return this.#commit(state=>transition(state,frozenActor,frozenCommand));
  }
  dispatchOutbox(command) {
    const frozenCommand=structuredClone(command);
    return this.#commit(state=>outboxTransition(state,frozenCommand));
  }
  dispatchRuntime(command) {
    const frozenCommand=structuredClone(command);
    return this.#commit(state=>runtimeTransition(state,frozenCommand));
  }
  #commit(reduce) {
    if(this.#closing || this.#closed)return Promise.reject(new Error('Store is closing or closed'));
    const operation = this.#queue.then(async () => {
      if (this.#closed) throw new Error('Store is closed');
      const next = reduce(this.#state);
      if(next===this.#state)return this.snapshot();
      // JSON normalization matches legacy persistence (e.g. omitted undefined).
      const persisted=JSON.parse(JSON.stringify(next));
      const bytes=Buffer.from(JSON.stringify(encodeJournal(this.#persisted,persisted))+'\n');
      const length = (await this.#file.stat()).size;
      try {
        let offset = 0;
        while (offset < bytes.length) {
          const { bytesWritten } = await this.#file.write(bytes, offset, bytes.length-offset, length+offset);
          if (!bytesWritten) throw new Error('Journal write made no progress');
          offset += bytesWritten;
        }
        await this.#file.sync();
      }
      catch(e) { await this.#file.truncate(length); await this.#file.sync(); throw e; }
      this.#state = next; this.#persisted=persisted; this.#readCache=undefined; return this.snapshot();
    });
    this.#queue = operation.catch(() => {}); return operation;
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closing=(async()=>{
      await this.#queue;
      this.#closed = true;
      await this.#file?.close();
      try {
        if (this.#lock) { await this.#lock.handle.close(); await fs.unlink(this.#lock.path); this.#lock = null; }
      } finally {this.#guard?.close();this.#guard=null;}
    })();
    return this.#closing;
  }
}
