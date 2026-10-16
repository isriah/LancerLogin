export const operatorPresenceApp = `
export function createOperatorPresence({onState = () => {}, onError = () => {}} = {}) {
  const pageId = crypto.randomUUID();
  let generation, mode, timer, stopped = false, chain = Promise.resolve();
  function send(action, nextMode) {
    const operation = chain.catch(() => {}).then(async () => {
      const requestMode = action === 'renew' ? mode : nextMode;
      const response = await fetch('/operator-presence', {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({action,pageId,mode:requestMode,...(action === 'enter' ? {} : {generation})}), signal:AbortSignal.timeout(5000)});
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Kiosk page session unavailable. Retry attendance.');
      generation = result.generation; mode = result.mode;
      onState(result); return result;
    });
    chain = operation;
    operation.catch(error => onError(error instanceof Error ? error : new Error('Kiosk page session unavailable.')));
    return operation;
  }
  function schedule() { clearInterval(timer); if (!stopped) timer = setInterval(() => { if (mode) void send('renew',mode).catch(() => {}); },5000); }
  return {
    async enter(nextMode) { stopped = false; mode = nextMode; const result = await send('enter',nextMode); schedule(); return result; },
    async transition(nextMode) { const result = await send('transition',nextMode); schedule(); return result; },
    async leave() { stopped = true; clearInterval(timer); return send('leave',mode); },
    retry() { return this.enter(mode || 'attendance'); },
    stop() { stopped = true; clearInterval(timer); }
  };
}
`;
