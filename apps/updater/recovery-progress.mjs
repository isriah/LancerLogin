// Serialized into the independent page; keep this function self-contained.
export function createRecoveryProgress({ read, advance, show, notice, visible = () => document.visibilityState === 'visible', later = (fn, ms) => setTimeout(fn, ms), cancel = clearTimeout, now = Date.now }) {
  let state, armed = null, flight = null, timer, needsRead = true, unchanged = 0, errors = 0, previous = '', intent = 0;
  const runnable = value => value?.job && (['running','reconciling'].includes(value.job.status) || (['succeeded','recovered'].includes(value.job.status) && value.maintenance && value.maintenance.state !== 'open'));
  function stopTimer() { if (timer !== undefined) cancel(timer); timer = undefined; }
  function pause(reason = 'Automatic progress paused. Continue when ready.') { intent++; armed = null; stopTimer(); notice(reason); }
  function checkExpiry() {
    const expired = Number.isFinite(state?.expiresAt) && now() >= state.expiresAt * 1000;
    if (expired && armed) pause('Recovery sign-in has reached its expiry time. Sign in again, then explicitly continue this job.');
    return expired;
  }
  function accept(value) { state = value; show(value); if (armed && (!runnable(value) || value.job.id !== armed)) pause(value?.maintenance?.state === 'open' ? 'The job is complete and the application is available.' : 'Automatic progress stopped. Review the current job.'); }
  function schedule(ms = 1000) { stopTimer(); if (!checkExpiry() && armed && visible() && !flight) timer = later(() => { void step(); }, ms); }
  function run(task) {
    if (flight) return flight;
    stopTimer(); const pending = Promise.resolve().then(task).finally(() => { if (flight === pending) flight = null; }); flight = pending; return pending;
  }
  async function step() {
    if (checkExpiry() || !armed || !visible() || flight) return;
    let delay = 1000;
    try {
      await run(async () => {
        if (needsRead) { accept(await read()); needsRead = false; return; }
        const job = armed; if (!runnable(state) || state.job.id !== job) return pause();
        const value = await advance(job); accept(value); errors = 0;
        delay = 250;
        const fingerprint = JSON.stringify([value.job?.id,value.job?.status,value.job?.step,value.job?.completedSteps,value.job?.operationId,value.maintenance?.phase,value.maintenance?.state]);
        unchanged = value.job?.status === 'reconciling' && fingerprint === previous ? unchanged + 1 : 0; previous = fingerprint;
        if (unchanged >= 5) pause('Reconciliation has not progressed. Automatic progress is paused; refresh status before continuing.');
        else if (value.job?.status === 'reconciling') delay = Math.min(30000, 2000 * 2 ** unchanged);
      });
    } catch (error) {
      needsRead = true;
      if (error?.status === 401) pause('Recovery sign-in expired. Sign in again, then explicitly continue this job.');
      else if (++errors >= 3) pause('The response is uncertain. Automatic progress is paused; refresh status before continuing.');
      else { notice('The response is uncertain. Reading status before continuing the same job.'); delay = 2000 * 2 ** errors; }
    }
    schedule(delay);
  }
  return Object.freeze({
    accept,
    checkExpiry,
    arm(jobId) { if (checkExpiry() || !runnable(state) || state.job.id !== jobId) return; armed = jobId; unchanged = errors = 0; previous = ''; needsRead = true; notice('Automatic progress is active while this page is visible.'); schedule(0); },
    pause,
    visibilityChanged() { stopTimer(); needsRead = true; if (armed && visible()) schedule(0); else if (armed) notice('Automatic progress waits while this page is hidden.'); },
    async refresh() { if (flight) return flight; return run(async () => { accept(await read()); needsRead = false; }).finally(() => schedule()); },
    async action(task, selectJob) { pause(''); const admittedIntent = intent; if (flight) await flight.catch(() => {}); const value = await run(async () => { const value = await task(); accept(value); return value; }); if (selectJob && admittedIntent === intent) { const id = selectJob(value); if (id && runnable(state) && state.job.id === id) { armed = id; unchanged = errors = 0; previous = ''; needsRead = true; notice('Automatic progress is active while this page is visible.'); schedule(0); } } return value; },
    active: () => armed !== null,
  });
}
