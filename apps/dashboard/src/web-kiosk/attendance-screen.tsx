// The paired kiosk: member ID entry or member search, the confirm step, the PIN step at a Require PIN kiosk, the result,
// and maintenance. In the background it refreshes its config and roster, sends heartbeats, syncs its offline queue
// and the wrong PIN tries made offline, and runs commands from the Kiosks page. The last config and roster are kept on
// the device, so the kiosk also starts without a network.
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { kioskState } from "../../../kiosk/src/kiosk-presentation.mjs";
import { KioskApiError, KioskNetworkError, type KioskApi, type KioskConfig, type RosterMember } from "./kiosk-api.ts";
import { createKioskClock, usableClockOffset, type KioskClock } from "./kiosk-clock.ts";
import {
  commandActionFor, commandPollMs, configRefreshMs, confirmTimeoutMs, connectionStatus, credentialRejected, displayForQueuedScan, displayForScanFate,
  flowReducer, heartbeatMs, initialFlow, kioskBrandStyle, memberLookupFor, memberName, pinIdleSteps, rosterChanged, rosterRefreshMs, type Flow, type KioskMember, type PinStart,
} from "./kiosk-flow.ts";
import { stateKeys, type KioskStore, type QueuedScan, type StoredPairing } from "./kiosk-store.ts";
import { createScanSync, type RefusedScan, type ScanSync } from "./kiosk-sync.ts";
import {
  afterOfflineMatch, afterPinFailureReport, choosePinStep, memberPinState, pinFailureReport, pinIdleTimeoutMs, pinLockFor, pinLockoutFor, pinOutcomeFor, pinRequestPollMs,
  recordOfflineFailure, requirePinFor, rosterHasPinData, usablePinFailures, verifyMemberPin, withoutPinData, type PinFailureLedger, type PinOutcome,
} from "./member-pin.ts";
import type { SettingsPinHash } from "./settings-pin.ts";
import { usePhysicalKeys, type PhysicalKeyHandlers } from "./on-screen-keys.tsx";
import { KioskFrame, ResultView } from "./kiosk-parts.tsx";
import { ChooseSettingsPin, EnterSettingsPin } from "./settings-pin-screens.tsx";
import { EntryView, SearchView } from "./lookup-views.tsx";
import { ChoosePinPad, MemberPinEntry, MemberPinMaintenance, NoPinView, PinLockedView, WaitingView, WrongPinView } from "./member-pin-screens.tsx";

type Maintenance = "pin" | "choose" | "menu" | "confirm_unpair" | "member_set" | "member_reset";
type CachedRoster = { members: RosterMember[]; etag?: string };
const defaultResultMs = 2_600;
/** How long a member waits after Confirm for the queue to reach the server before seeing "Saved for sync". */
const scanAnswerWaitMs = 10_000;
const wait = (ms: number) => new Promise<void>((resolve) => { window.setTimeout(resolve, ms); });

function usableCachedRoster(value: unknown): CachedRoster | undefined {
  const record = value as Partial<CachedRoster> | undefined;
  if (!record || typeof record !== "object" || !Array.isArray(record.members)) return undefined;
  return { members: record.members.filter((member) => member && typeof member.memberId === "string"), ...(typeof record.etag === "string" ? { etag: record.etag } : {}) };
}
function usableCachedConfig(value: unknown): KioskConfig | undefined {
  const record = value as Partial<KioskConfig> | undefined;
  return record && typeof record === "object" && record.kiosk && typeof record.kiosk.name === "string" ? record as KioskConfig : undefined;
}

export function AttendanceScreen({ api, store, pairing, releaseVersion, onPairingChange, onUnpair, onCredentialRejected }: {
  api: KioskApi; store: KioskStore; pairing: StoredPairing; releaseVersion: string;
  onPairingChange: (pairing: StoredPairing) => Promise<void>; onUnpair: () => Promise<void>; onCredentialRejected: () => void;
}) {
  const [config, setConfig] = useState<KioskConfig>(); const configRef = useRef<KioskConfig | undefined>(undefined);
  const [roster, setRosterState] = useState<RosterMember[]>(); const rosterTag = useRef<string | undefined>(undefined);
  const rosterRef = useRef<RosterMember[] | undefined>(undefined);
  const setRoster = useCallback((members: RosterMember[]) => { rosterRef.current = members; setRosterState(members); }, []);
  const [online, setOnlineState] = useState<boolean | undefined>(() => typeof navigator !== "undefined" && navigator.onLine === false ? false : undefined);
  const onlineRef = useRef(online);
  /** Called when the server answers again after the kiosk was offline: send what's waiting at once. */
  const reconnected = useRef<() => void>(() => undefined);
  const setOnline = useCallback((value: boolean) => {
    const was = onlineRef.current; onlineRef.current = value; setOnlineState(value);
    if (value && was === false) reconnected.current();
  }, []);
  const [pending, setPending] = useState(0); const [refused, setRefused] = useState<RefusedScan[]>([]);
  const [flow, dispatch] = useReducer(flowReducer, initialFlow);
  const [maintenance, setMaintenance] = useState<Maintenance>(); const [maintenanceError, setMaintenanceError] = useState("");
  const [secondsLeft, setSecondsLeft] = useState(0);
  const pairingRef = useRef(pairing); pairingRef.current = pairing;
  const handlers = useRef({ onPairingChange, onCredentialRejected }); handlers.current = { onPairingChange, onCredentialRejected };
  const clockRef = useRef<KioskClock>(createKioskClock());
  const flowRef = useRef<Flow>(flow); flowRef.current = flow;
  /** Wrong PIN tries made offline, until the server has them; saved in the state store after every change. */
  const pinFailures = useRef<PinFailureLedger>([]);
  /** Locks the server reported since the roster was last loaded, by member ID. */
  const serverLocks = useRef(new Map<string, string>());

  const refreshCounts = useCallback(() => {
    void store.queue.count().then(setPending, () => undefined);
    void store.read<RefusedScan[]>(stateKeys.rejected).then((list) => setRefused(Array.isArray(list) ? list : []), () => undefined);
  }, [store]);

  const savePinFailures = useCallback(async (ledger: PinFailureLedger) => {
    pinFailures.current = ledger;
    await store.write(stateKeys.pinFailures, ledger).catch(() => undefined);
  }, [store]);

  const sync: ScanSync = useMemo(() => createScanSync({
    queue: store.queue,
    refused: {
      list: async () => { const list = await store.read<RefusedScan[]>(stateKeys.rejected); return Array.isArray(list) ? list : []; },
      save: (scans) => store.write(stateKeys.rejected, scans),
    },
    send: async ({ queuedAt: _queuedAt, ...scan }: QueuedScan) => {
      const outcome = await api.deliver({ ...scan, rescanSupported: true });
      if (outcome.kind === "unreachable") setOnline(false);
      else if (outcome.kind !== "credential" && !(outcome.kind === "retry" && outcome.status >= 500)) setOnline(true);
      return outcome;
    },
    sendReviews: (records) => api.scanReviews(records),
    onCredentialRejected: () => handlers.current.onCredentialRejected(),
    onChange: refreshCounts,
  }), [api, store, refreshCounts, setOnline]);

  /** Runs a background request, tracking whether the server answers. A refused credential means pairing again. */
  const track = useCallback(async <T,>(request: () => Promise<T>): Promise<T | undefined> => {
    try { const result = await request(); setOnline(true); return result; }
    catch (error) {
      if (credentialRejected(error)) { handlers.current.onCredentialRejected(); return undefined; }
      if (error instanceof KioskNetworkError || error instanceof KioskApiError && error.status >= 500) setOnline(false);
      return undefined;
    }
  }, [setOnline]);

  /** Keeps a roster on the device; PIN hashes only while the kiosk requires a PIN. */
  const keepRoster = useCallback((members: RosterMember[], etag: string | undefined) => {
    // Hashes that came before the kiosk saw Require PIN turned off are dropped, with the ETag they came under.
    const stripped = !requirePinFor(configRef.current) && rosterHasPinData(members);
    const kept = stripped ? withoutPinData(members) : members;
    setRoster(kept);
    // Otherwise kept exactly as the server sent it: emails only for a kiosk in Member search mode.
    void store.write(stateKeys.roster, { members: kept, ...(etag && !stripped ? { etag } : {}) }).catch(() => undefined);
  }, [store, setRoster]);

  const loadRoster = useCallback(async () => {
    const result = await track(() => api.roster(rosterTag.current));
    if (!result) return;
    rosterTag.current = result.etag;
    if (result.members) { serverLocks.current.clear(); keepRoster(result.members, result.etag); }
  }, [api, track, keepRoster]);

  /** Require PIN is off: the device forgets the cached PIN hashes and the wrong tries it was keeping. */
  const forgetPinData = useCallback(() => {
    const current = rosterRef.current;
    if (current && rosterHasPinData(current)) { rosterTag.current = undefined; keepRoster(current, undefined); }
    serverLocks.current.clear();
    if (pinFailures.current.length) void savePinFailures([]);
  }, [keepRoster, savePinFailures]);

  const fromServer = useRef(false);
  const loadConfig = useCallback(async () => {
    const next = await track(() => api.config());
    if (!next) return;
    const before = configRef.current; configRef.current = next; setConfig(next);
    void store.write(stateKeys.config, next).catch(() => undefined);
    if (!requirePinFor(next)) forgetPinData();
    const first = !fromServer.current; fromServer.current = true;
    if (!before || rosterChanged(before, next)) { rosterTag.current = undefined; await loadRoster(); }
    else if (first) await loadRoster();
  }, [api, store, track, loadRoster, forgetPinData]);

  /** Reports wrong PIN tries made offline, then reloads the roster, which carries any lock they started. */
  const pinReporting = useRef(false);
  const reportPinFailures = useCallback(async () => {
    const report = pinFailureReport(pinFailures.current);
    if (!report.length || pinReporting.current) return;
    pinReporting.current = true;
    try {
      if (!await track(() => api.pinFailures(report))) return;
      await savePinFailures(afterPinFailureReport(pinFailures.current, report));
      await loadRoster();
    } finally { pinReporting.current = false; }
  }, [api, track, savePinFailures, loadRoster]);

  const commandBusy = useRef(false);
  const pollCommands = useCallback(async () => {
    if (commandBusy.current) return; commandBusy.current = true;
    try {
      const command = await track(() => api.command());
      if (!command) return;
      const action = commandActionFor(command.type);
      if (action === "reload") {
        await track(() => api.completeCommand(command.id, { success: true, message: "Reloading the display" }));
        window.location.reload();
      } else if (action === "reset_pin") {
        const { settingsPin: _cleared, ...rest } = pairingRef.current;
        try { await handlers.current.onPairingChange(rest); }
        catch { await track(() => api.completeCommand(command.id, { success: false, message: "The settings PIN couldn't be cleared on this device" })); return; }
        await track(() => api.completeCommand(command.id, { success: true, message: "Settings PIN cleared; a new one is chosen at the next maintenance open" }));
      } else await track(() => api.completeCommand(command.id, { success: false, message: "Web kiosks can only reload their display or reset their settings PIN" }));
    } finally { commandBusy.current = false; }
  }, [api, track]);

  /** Syncs the queue (unless it is waiting after a failure), then reports the queue length and measures the clock. */
  const heartbeat = useCallback(async () => {
    await sync.sync().catch(() => undefined);
    await reportPinFailures().catch(() => undefined);
    const waiting = await sync.pending().catch(() => 0);
    const delivered = sync.lastDeliveredAt();
    const lastSyncAt = delivered === undefined ? undefined : new Date(delivered + (clockRef.current.offset()?.offsetMs ?? 0)).toISOString();
    const sentAt = Date.now();
    const reply = await track(() => api.heartbeat(releaseVersion, waiting, lastSyncAt));
    if (!reply) return;
    const offset = clockRef.current.update(sentAt, Date.now(), reply.receivedAt);
    if (offset) void store.write(stateKeys.clock, offset).catch(() => undefined);
    void sync.uploadRefused().catch(() => undefined);
    refreshCounts();
  }, [api, store, sync, track, releaseVersion, refreshCounts, reportPinFailures]);

  useEffect(() => {
    let stopped = false;
    const timers: number[] = [];
    // Start from what the device kept, so the kiosk works when it starts without a network; then ask the server.
    void (async () => {
      const [cachedConfig, cachedRoster, cachedClock, cachedFailures] = await Promise.all([
        store.read(stateKeys.config).catch(() => undefined), store.read(stateKeys.roster).catch(() => undefined), store.read(stateKeys.clock).catch(() => undefined),
        store.read(stateKeys.pinFailures).catch(() => undefined),
      ]);
      if (stopped) return;
      const offset = usableClockOffset(cachedClock);
      if (offset && !clockRef.current.offset()) clockRef.current = createKioskClock({ initial: offset });
      const savedConfig = usableCachedConfig(cachedConfig), savedRoster = usableCachedRoster(cachedRoster);
      if (savedConfig && !configRef.current) { configRef.current = savedConfig; setConfig(savedConfig); }
      if (!pinFailures.current.length) pinFailures.current = usablePinFailures(cachedFailures);
      if (savedRoster && !rosterRef.current) {
        rosterTag.current ??= savedRoster.etag;
        // PIN hashes left from before Require PIN was turned off (say, the page closed in between) go now.
        if (savedConfig && !requirePinFor(savedConfig) && rosterHasPinData(savedRoster.members)) { rosterTag.current = undefined; keepRoster(savedRoster.members, undefined); }
        else setRoster(savedRoster.members);
      }
      if (savedConfig && !requirePinFor(savedConfig)) forgetPinData();
      refreshCounts();
      void loadConfig();
      void heartbeat(); void pollCommands();
      timers.push(
        window.setInterval(() => void loadConfig(), configRefreshMs), window.setInterval(() => void loadRoster(), rosterRefreshMs),
        window.setInterval(() => void heartbeat(), heartbeatMs), window.setInterval(() => void pollCommands(), commandPollMs),
      );
    })();
    // The network came back (the browser says so, or the server answered again): send what's waiting at once, then
    // report in.
    const wentOnline = () => { void sync.online().catch(() => undefined).then(() => heartbeat()); void loadConfig(); };
    reconnected.current = wentOnline;
    const wentOffline = () => setOnline(false);
    window.addEventListener("online", wentOnline); window.addEventListener("offline", wentOffline);
    return () => {
      stopped = true; timers.forEach((timer) => window.clearInterval(timer));
      window.removeEventListener("online", wentOnline); window.removeEventListener("offline", wentOffline);
      reconnected.current = () => undefined;
    };
  }, [store, sync, loadConfig, loadRoster, pollCommands, heartbeat, refreshCounts, setOnline, keepRoster, setRoster, forgetPinData]);

  const lookup = memberLookupFor(config);
  const requirePin = requirePinFor(config);
  useEffect(() => { dispatch({ type: "reset" }); }, [lookup, requirePin]);

  // The confirm step goes back to the start after 15 seconds; the result after its display time. A layout effect, so
  // the countdown starts at 15 on the confirm screen's first paint.
  useLayoutEffect(() => {
    if (flow.step === "confirm") {
      const until = Date.now() + confirmTimeoutMs; setSecondsLeft(Math.ceil(confirmTimeoutMs / 1000));
      const tick = window.setInterval(() => setSecondsLeft(Math.max(0, Math.ceil((until - Date.now()) / 1000))), 250);
      const timeout = window.setTimeout(() => dispatch({ type: "timeout" }), confirmTimeoutMs);
      return () => { window.clearInterval(tick); window.clearTimeout(timeout); };
    }
    if (flow.step === "result") { const timeout = window.setTimeout(() => dispatch({ type: "done" }), flow.display.durationMs ?? defaultResultMs); return () => window.clearTimeout(timeout); }
    return undefined;
  }, [flow]);

  // The PIN screens go back to the start after 30 seconds with no tap or key.
  useEffect(() => {
    if (maintenance || !pinIdleSteps.has(flow.step)) return undefined;
    let timer = window.setTimeout(() => dispatch({ type: "timeout" }), pinIdleTimeoutMs);
    const activity = () => { window.clearTimeout(timer); timer = window.setTimeout(() => dispatch({ type: "timeout" }), pinIdleTimeoutMs); };
    window.addEventListener("keydown", activity, true); window.addEventListener("pointerdown", activity, true);
    return () => { window.clearTimeout(timer); window.removeEventListener("keydown", activity, true); window.removeEventListener("pointerdown", activity, true); };
  }, [flow, maintenance]);

  // The waiting screen asks every 3 seconds whether an Operator decided, and gives up once the request runs out.
  const waitingRequest = flow.step === "waiting" && !maintenance ? flow.requestId : undefined;
  useEffect(() => {
    if (!waitingRequest) return undefined;
    let stopped = false, busy = false;
    const expire = (expiresAt: string) => dispatch({ type: "request_status", request: { id: waitingRequest, status: "expired", expiresAt } });
    const tick = async () => {
      const current = flowRef.current;
      if (stopped || busy || current.step !== "waiting" || current.requestId !== waitingRequest) return;
      if (Date.parse(current.expiresAt) <= clockRef.current.now()) { expire(current.expiresAt); return; }
      busy = true;
      try { const request = await api.pinRequest(waitingRequest); setOnline(true); if (!stopped) dispatch({ type: "request_status", request }); }
      catch (error) {
        if (credentialRejected(error)) handlers.current.onCredentialRejected();
        else if (error instanceof KioskNetworkError) setOnline(false);
        else if (error instanceof KioskApiError && error.status === 404 && !stopped) expire(current.expiresAt);
      } finally { busy = false; }
    };
    const timer = window.setInterval(() => void tick(), pinRequestPollMs);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [waitingRequest, api, setOnline]);

  const settings = config?.settings;
  const brand = { organizationName: settings?.organizationName || "LancerLogin", logoData: settings?.logoData || undefined };
  useEffect(() => { document.title = `${brand.organizationName} kiosk`; }, [brand.organizationName]);

  const newScan = (member: KioskMember): QueuedScan => ({ eventId: crypto.randomUUID(), memberId: member.memberId, occurredAt: clockRef.current.occurredAt(), pairingId: pairingRef.current.pairingId, queuedAt: new Date().toISOString() });
  const rosterMember = (memberId: string) => rosterRef.current?.find((item) => item.memberId === memberId);
  const pinLock = (memberId: string) => pinLockFor({ member: rosterMember(memberId) ?? { memberId, firstName: "", lastName: "" }, ledger: pinFailures.current, serverLock: serverLocks.current.get(memberId), now: clockRef.current.now() });

  /** Saves the scan on the device first, then sends the queue in order; shows the server's answer, or "Saved for sync". */
  async function confirm(member: KioskMember) {
    if (requirePinFor(configRef.current)) { await confirmForPin(member); return; }
    dispatch({ type: "confirm" });
    const scan = newScan(member);
    let before: QueuedScan[];
    try { before = await store.queue.list(); await sync.enqueue(scan); }
    catch {
      dispatch({ type: "sent", display: kioskState("rejected", { detail: "This scan could not be saved. Ask an operator for help.", durationMs: 3_500 }) });
      return;
    }
    const report = await Promise.race([sync.sync({ force: true }).catch(() => undefined), wait(scanAnswerWaitMs).then(() => undefined)]);
    if (report?.stopped === "credential") return;
    const fate = sync.fate(scan.eventId);
    dispatch({ type: "sent", display: fate ? displayForScanFate(fate, member) : displayForQueuedScan(member, before) });
  }

  /** At a Require PIN kiosk, Confirm leads to the PIN keypad, or "You don't have a PIN yet", or refuses a locked member. */
  const confirming = useRef(false);
  async function confirmForPin(member: KioskMember) {
    if (confirming.current) return; confirming.current = true;
    try {
      let lock = pinLock(member.memberId);
      // The lock may have been lifted on the dashboard since the roster was loaded.
      if (lock && onlineRef.current !== false) { await loadRoster(); lock = pinLock(member.memberId); }
      const start: PinStart = lock ? { kind: "locked", lockedUntil: lock } : memberPinState(rosterMember(member.memberId)) === "none" ? { kind: "none" } : { kind: "entry" };
      dispatch({ type: "confirm", pin: start });
    } finally { confirming.current = false; }
  }

  /** A PIN answer from the server: remember a lock it reports, and reload the roster where it is out of date. */
  function pinRefused(member: KioskMember, outcome: PinOutcome) {
    const lockedUntil = outcome.kind === "wrong" || outcome.kind === "locked" ? outcome.lockedUntil : undefined;
    if (lockedUntil) serverLocks.current.set(member.memberId, lockedUntil);
    if (outcome.kind === "not_set" || outcome.kind === "locked" || lockedUntil) void loadRoster();
    dispatch({ type: "pin_refused", outcome });
  }

  /**
   * Sends a scan with the member's PIN for the server to check. The PIN is never saved: when the server can't be
   * reached the kiosk checks the cached hash instead, and on a match queues the scan with `pinCheck: "offline"`.
   * `trusted` is for a PIN the member has just set, which needs no check.
   */
  async function sendPinScan(member: KioskMember, pin: string, { trusted = false } = {}) {
    const scan = newScan(member);
    // Scans already waiting go first, so the server sees them in the order they were taken.
    let waiting = await sync.pending().catch(() => 0);
    if (waiting > 0) {
      await Promise.race([sync.sync({ force: true }).catch(() => undefined), wait(scanAnswerWaitMs)]);
      waiting = await sync.pending().catch(() => 0);
    }
    if (waiting === 0) {
      const { queuedAt: _queuedAt, ...fields } = scan;
      const outcome = await api.deliver({ ...fields, rescanSupported: true, pin });
      if (outcome.kind === "credential") { handlers.current.onCredentialRejected(); return; }
      if (outcome.kind === "unreachable" || outcome.kind === "retry" && outcome.status >= 500) setOnline(false);
      else setOnline(true);
      if (outcome.kind === "accepted" || outcome.kind === "rejected" || outcome.kind === "rescan") {
        const pinOutcome = pinOutcomeFor(outcome);
        if (pinOutcome) { pinRefused(member, pinOutcome); return; }
        await sync.settle(scan, outcome).catch(() => undefined);
        dispatch({ type: "sent", display: displayForScanFate(outcome, member) });
        return;
      }
    }
    await checkPinOffline(member, pin, scan, trusted);
  }

  /** The server can't be reached: check the PIN against the cached hash, and queue the scan on a match. */
  async function checkPinOffline(member: KioskMember, pin: string, scan: QueuedScan, trusted: boolean) {
    if (!trusted) {
      const cached = rosterMember(member.memberId);
      const state = memberPinState(cached);
      if (state === "none") { dispatch({ type: "pin_refused", outcome: { kind: "not_set" } }); return; }
      if (state === "unknown") {
        dispatch({ type: "sent", display: kioskState("rejected", { message: "Couldn't check your PIN", detail: "This kiosk can't reach the server. Try again once it's back online.", durationMs: 3_500 }) });
        return;
      }
      const lock = pinLock(member.memberId);
      if (lock) { dispatch({ type: "pin_refused", outcome: { kind: "locked", lockedUntil: lock } }); return; }
      let match = false;
      try { match = await verifyMemberPin(pin, cached!.pin); } catch { match = false; }
      if (!match) {
        const counted = recordOfflineFailure(pinFailures.current, member.memberId, clockRef.current.now(), pinLockoutFor(configRef.current));
        await savePinFailures(counted.ledger);
        dispatch({ type: "pin_refused", outcome: { kind: "wrong", ...(counted.lockedUntil ? { lockedUntil: counted.lockedUntil } : {}) } });
        return;
      }
      if (pinFailures.current.some((item) => item.memberId === member.memberId)) await savePinFailures(afterOfflineMatch(pinFailures.current, member.memberId));
    }
    let before: QueuedScan[];
    try { before = await store.queue.list(); await sync.enqueue({ ...scan, pinCheck: "offline" }); }
    catch {
      dispatch({ type: "sent", display: kioskState("rejected", { detail: "This scan could not be saved. Ask an operator for help.", durationMs: 3_500 }) });
      return;
    }
    dispatch({ type: "sent", display: displayForQueuedScan(member, before) });
  }

  function enterPin(member: KioskMember, pin: string) {
    dispatch({ type: "pin_entered" });
    void sendPinScan(member, pin);
  }

  async function askForApproval(member: KioskMember) {
    dispatch({ type: "ask" });
    try { const request = await api.requestPin(member.memberId); setOnline(true); dispatch({ type: "asked", request }); }
    catch (error) {
      if (credentialRejected(error)) { handlers.current.onCredentialRejected(); return; }
      if (error instanceof KioskNetworkError) { setOnline(false); dispatch({ type: "ask_failed", message: "Couldn't reach the server. Check the connection and try again." }); return; }
      if (error instanceof KioskApiError && error.code === "pin_already_set") { void loadRoster(); dispatch({ type: "has_pin" }); return; }
      dispatch({ type: "ask_failed", message: error instanceof KioskApiError && error.message ? error.message : "The request couldn't be sent. Try again." });
    }
  }

  /** Choose a PIN after approval: typed twice, saved under the request, then the scan is recorded with it. */
  async function choosePin(current: Extract<Flow, { step: "choose_pin" }>, pin: string) {
    const step = choosePinStep(current.first, pin);
    if ("problem" in step) { dispatch({ type: "choose_problem", problem: step.problem }); return; }
    if ("first" in step) { dispatch({ type: "choose_first", pin: step.first }); return; }
    const member = current.member;
    dispatch({ type: "pin_chosen" });
    try { await api.choosePin(current.requestId, step.pin); setOnline(true); }
    catch (error) {
      if (credentialRejected(error)) { handlers.current.onCredentialRejected(); return; }
      if (error instanceof KioskNetworkError) setOnline(false);
      const code = error instanceof KioskApiError ? error.code : undefined;
      const display = code === "pin_request_not_approved" ? kioskState("rejected", { message: "The approval ran out", detail: "Ask for approval again.", durationMs: 4_000 })
        : code === "pin_already_set" ? kioskState("duplicate", { message: "You already have a PIN", detail: "Enter your member ID again and use it.", durationMs: 4_000 })
          : kioskState("rejected", { message: "Your PIN wasn't saved", detail: error instanceof KioskNetworkError ? "Couldn't reach the server. Try again." : "Ask an Operator for help.", durationMs: 4_000 });
      dispatch({ type: "sent", display });
      return;
    }
    void loadRoster();
    await sendPinScan(member, step.pin, { trusted: true });
  }

  function openMaintenance() { setMaintenanceError(""); refreshCounts(); dispatch({ type: "reset" }); setMaintenance(pairingRef.current.settingsPin ? "pin" : "choose"); }
  async function savePin(settingsPin: SettingsPinHash) { await onPairingChange({ ...pairingRef.current, settingsPin }); setMaintenance("menu"); }
  async function unpair() {
    try { await onUnpair(); }
    catch { setMaintenanceError("This kiosk couldn't clear its storage. Try again."); setMaintenance("menu"); }
  }

  // Enter and Escape on the screens without a field; the entry, search and PIN screens handle their own keys.
  let keys: PhysicalKeyHandlers = {};
  if (maintenance === "menu") keys = { onEscape: () => setMaintenance(undefined) };
  else if (maintenance === "confirm_unpair") keys = { onEscape: () => setMaintenance("menu") };
  else if (!maintenance && flow.step === "confirm") { const member = flow.member; keys = { onEnter: () => void confirm(member), onEscape: () => dispatch({ type: "not_me" }) }; }
  usePhysicalKeys("digits", keys);

  const style = kioskBrandStyle(settings) as CSSProperties;
  const status = maintenance ? "Maintenance" : flow.step === "confirm" ? `Returns to start in ${secondsLeft} s` : flow.step === "waiting" ? "Request sent to the dashboard" : connectionStatus(online, pending);
  const refusedAwaitingUpload = refused.filter((item) => !item.cloud).length;
  const cancel = () => dispatch({ type: "cancel" });

  let body;
  if (maintenance === "pin" && pairing.settingsPin) body = <EnterSettingsPin stored={pairing.settingsPin} onVerified={() => setMaintenance("menu")} onCancel={() => setMaintenance(undefined)} />;
  else if (maintenance === "pin" || maintenance === "choose") body = <ChooseSettingsPin intro="This kiosk has no settings PIN yet." onChosen={savePin} onCancel={() => setMaintenance(undefined)} />;
  else if (maintenance === "menu") body = <div className="wk-centered wk-menu">
    <h1 className="wk-title">Maintenance</h1>
    <p className="wk-sub">{pairing.name}</p>
    <dl className="wk-facts">
      <div><dt>Scans waiting to sync</dt><dd data-testid="wk-pending-count">{pending}</dd></div>
      <div><dt>Scans the server refused</dt><dd data-testid="wk-refused-count">{refused.length}{refused.length > 0 && <small>{refusedAwaitingUpload ? `${refusedAwaitingUpload} not yet sent for review` : "Sent for review on the dashboard"}</small>}</dd></div>
    </dl>
    {maintenanceError && <p className="wk-note wk-note-error" role="alert">{maintenanceError}</p>}
    <div className="wk-actions wk-actions-stack">
      {requirePin && <>
        <button type="button" className="wk-button" onClick={() => setMaintenance("member_set")}>Set member PIN</button>
        <button type="button" className="wk-button" onClick={() => setMaintenance("member_reset")}>Reset member PIN</button>
      </>}
      <button type="button" className="wk-button wk-button-danger" onClick={() => setMaintenance("confirm_unpair")}>Unpair this kiosk</button>
      <button type="button" className="wk-button" onClick={() => setMaintenance(undefined)}>Back</button>
    </div>
  </div>;
  else if (maintenance === "member_set" || maintenance === "member_reset") body = <MemberPinMaintenance key={maintenance} task={maintenance === "member_set" ? "set" : "reset"} api={api} roster={roster} lookup={lookup} online={online}
    onChanged={() => void loadRoster()} onBack={() => setMaintenance("menu")} />;
  else if (maintenance === "confirm_unpair") body = <div className="wk-centered wk-menu">
    <h1 className="wk-title">Unpair this kiosk?</h1>
    <p className="wk-sub">It forgets its pairing and stops recording attendance. To use it again, create a new code on the Kiosks page. Retire the old kiosk there too.</p>
    {pending > 0 && <p className="wk-note wk-note-error" role="alert">{pending === 1 ? "1 scan hasn't reached the server yet and will be lost." : `${pending} scans haven't reached the server yet and will be lost.`} Connect the kiosk to the network first to sync them.</p>}
    <div className="wk-actions">
      <button type="button" className="wk-button" onClick={() => setMaintenance("menu")}>Cancel</button>
      <button type="button" className="wk-button wk-button-danger" onClick={() => void unpair()}>Unpair</button>
    </div>
  </div>;
  else if (flow.step === "confirm") body = <div className="wk-centered">
    <h1 className="wk-title">Is this you?</h1>
    <div className="wk-person"><b>{memberName(flow.member)}</b><small>Member ID {flow.member.memberId}</small></div>
    <div className="wk-actions">
      <button type="button" className="wk-button" onClick={() => dispatch({ type: "not_me" })}>{lookup === "search" ? "Back to search" : "Not me"}</button>
      <button type="button" className="wk-button wk-button-primary" onClick={() => void confirm(flow.member)}>Confirm</button>
    </div>
  </div>;
  else if (flow.step === "pin") { const member = flow.member; body = <MemberPinEntry member={member} onSubmit={(pin) => enterPin(member, pin)} onCancel={cancel} />; }
  else if (flow.step === "wrong_pin") body = <WrongPinView flow={flow} onTryAgain={() => dispatch({ type: "try_again" })} onCancel={cancel} />;
  else if (flow.step === "pin_locked") body = <PinLockedView flow={flow} onDone={cancel} />;
  else if (flow.step === "no_pin") { const member = flow.member; body = <NoPinView flow={flow} onAsk={() => void askForApproval(member)} onCancel={cancel} />; }
  else if (flow.step === "waiting") body = <WaitingView flow={flow} onCancel={cancel} />;
  else if (flow.step === "choose_pin") { const current = flow; body = <ChoosePinPad first={current.first} error={current.error} onSubmit={(pin) => void choosePin(current, pin)} onCancel={cancel} hint={current.first === undefined ? `Approved for ${memberName(current.member)}` : undefined} />; }
  else if (flow.step === "sending") body = <ResultView display={kioskState("processing", { message: "Recording attendance", detail: memberName(flow.member) })} />;
  else if (flow.step === "result") body = <ResultView display={flow.display} />;
  else if (!roster) body = <ResultView display={kioskState("processing", { message: online === false ? "Couldn't reach the server" : "Getting ready", detail: online === false ? "This kiosk keeps trying." : "Loading the roster" })} />;
  else if (lookup === "search") body = <SearchView text={flow.text} roster={roster} dispatch={dispatch} />;
  else body = <EntryView text={flow.text} roster={roster} dispatch={dispatch} />;

  return <div className="wk-root" style={style} data-step={maintenance ? "maintenance" : flow.step}>
    <KioskFrame brand={brand} onHold={maintenance ? undefined : openMaintenance} footerName={config?.kiosk.name ?? pairing.name} footerStatus={status} online={online}>{body}</KioskFrame>
  </div>;
}
