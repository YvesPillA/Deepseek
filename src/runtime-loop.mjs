/** Host-owned periodic runner. The gate is a trusted callback, never a model
 * argument. One iteration at a time; teardown drains before another runtime is
 * allowed to resume durable work. Failed starts/ticks back off without spinning. */
export class RuntimeLoop {
  #create;#enabled;#interval;#timer;#cancel;#pending;#runtime;#started=false;#closed=false;#closing;
  #active;#failures=0;#lastError=null;#maintenance;
  constructor({create,enabled,intervalMs=1000,schedule=setTimeout,cancel=clearTimeout}) {
    if(typeof create!=='function' || typeof enabled!=='function')throw new Error('Runtime factory and trusted gate required');
    if(!Number.isSafeInteger(intervalMs)||intervalMs<50||intervalMs>60000)throw new Error('Invalid scheduler interval');
    this.#create=create;this.#enabled=enabled;this.#interval=intervalMs;this.#timer=schedule;this.#cancel=cancel;
  }
  status(){return {started:this.#started,closed:this.#closed,running:!!this.#runtime,inFlight:!!this.#active,consecutiveFailures:this.#failures,error:this.#lastError};}
  start() {
    if(this.#closed)throw new Error('Runtime loop is closed');
    if(this.#started)return;
    this.#started=true;this.#schedule(0);
  }
  #schedule(delay) {
    if(this.#closed||this.#maintenance)return;
    this.#pending=this.#timer(()=>{this.#pending=undefined;void this.#poll();},delay);
    this.#pending?.unref?.();
  }
  async #poll() {
    if(this.#closed || this.#active || this.#maintenance)return;
    this.#active=(async()=>{
      try {
        if(!this.#enabled()) {
          if(this.#runtime){await this.#runtime.close();this.#runtime=undefined;}
          this.#failures=0;this.#lastError=null;return;
        }
        if(!this.#runtime)this.#runtime=await this.#create();
        // The gate/owner can change while an asynchronous factory is preparing.
        if(this.#closed || this.#maintenance || !this.#enabled()){await this.#runtime.close();this.#runtime=undefined;return;}
        await this.#runtime.tick();this.#failures=0;this.#lastError=null;
      } catch(e){this.#failures++;this.#lastError=String(e?.message??e).slice(0,4000);}
    })();
    try {await this.#active;}finally {
      this.#active=undefined;
      const delay=Math.min(60000,this.#interval*2**Math.min(this.#failures,6));
      this.#schedule(delay);
    }
  }
  close() {
    if(this.#closing)return this.#closing;
    this.#closed=true;
    if(this.#pending!==undefined){this.#cancel(this.#pending);this.#pending=undefined;}
    this.#closing=(async()=>{
      // Ask a resident runtime to stop now, including creation/tool cancellation;
      // do not wait for a blocked tick before issuing the stop request.
      const resident=this.#runtime;
      const stop=resident?Promise.resolve().then(()=>resident.close()):Promise.resolve();
      const results=await Promise.allSettled([stop,this.#active,this.#maintenance]);
      if(this.#runtime && this.#runtime!==resident)await this.#runtime.close();
      this.#runtime=undefined;
      const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);
      if(errors.length)throw new AggregateError(errors,'Runtime shutdown failed');
    })();return this.#closing;
  }
  runStopped(operation) {
    if(this.#closed||this.#maintenance)return Promise.reject(Error('Runtime maintenance is unavailable'));
    if(this.#pending!==undefined){this.#cancel(this.#pending);this.#pending=undefined;}
    const op=Promise.resolve().then(async()=>{
      const resident=this.#runtime;
      const results=await Promise.allSettled([resident?.close(),this.#active]);
      if(this.#runtime&&this.#runtime!==resident)await this.#runtime.close();
      if(results.some(r=>r.status==='rejected'))throw Error('Could not quiesce runtime for recovery');
      this.#runtime=undefined;
      if(this.#closed)throw Error('Runtime loop is closed');
      return operation();
    });
    this.#maintenance=op;
    void op.finally(()=>{this.#maintenance=undefined;if(this.#started)this.#schedule(0);}).catch(()=>{});
    return op;
  }
}
