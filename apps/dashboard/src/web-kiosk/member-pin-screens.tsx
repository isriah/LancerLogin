// The member PIN screens of a Require PIN kiosk (mockup section 3): PIN entry, Wrong PIN, PIN locked, "You don't have a
// PIN yet" and its waiting screen, and Choose a PIN; and the maintenance screens that set or reset a member's PIN.
import { useReducer, useState } from "react";
import { KioskApiError, KioskNetworkError, type KioskApi, type RosterMember } from "./kiosk-api.ts";
import { flowReducer, initialFlow, memberName, type Flow, type KioskMember, type MemberLookup } from "./kiosk-flow.ts";
import { choosePinStep, lockoutLine, memberPinMaxLength, memberPinMinLength } from "./member-pin.ts";
import { CenteredMessage, PinPad } from "./kiosk-parts.tsx";
import { EntryView, SearchView } from "./lookup-views.tsx";
import { usePhysicalKeys } from "./on-screen-keys.tsx";

export const offlinePinMaintenanceMessage = "Connect to the network to set or reset PINs.";
const pinPadLimits = { minLength: memberPinMinLength, maxLength: memberPinMaxLength, dots: memberPinMinLength, cancelOnKeypad: true } as const;

type Step<Name extends Flow["step"]> = Extract<Flow, { step: Name }>;

export function MemberPinEntry({ member, onSubmit, onCancel }: { member: KioskMember; onSubmit: (pin: string) => void; onCancel: () => void }) {
  return <PinPad title="Enter your PIN" detail={memberName(member)} onSubmit={onSubmit} onCancel={onCancel} {...pinPadLimits} />;
}

export function WrongPinView({ flow, onTryAgain, onCancel }: { flow: Step<"wrong_pin">; onTryAgain: () => void; onCancel: () => void }) {
  const line = lockoutLine(flow);
  usePhysicalKeys("digits", { onEnter: flow.lockedUntil ? onCancel : onTryAgain, onEscape: onCancel });
  return <div className="wk-result" data-tone="error" data-state="wrong_pin" role="status">
    <div className="wk-ring wk-ring-error" aria-hidden="true" />
    <h1 className="wk-title">Wrong PIN</h1>
    <p className="wk-sub">Try again, or ask an Operator to reset it.</p>
    {line && <p className={`wk-note ${flow.lockedUntil ? "wk-note-error" : "wk-note-warning"}`} role="alert">{line}</p>}
    <div className="wk-actions">
      {flow.lockedUntil
        ? <button type="button" className="wk-button wk-button-primary" onClick={onCancel}>Done</button>
        : <><button type="button" className="wk-button" onClick={onCancel}>Cancel</button><button type="button" className="wk-button wk-button-primary" onClick={onTryAgain}>Try again</button></>}
    </div>
  </div>;
}

export function PinLockedView({ flow, onDone }: { flow: Step<"pin_locked">; onDone: () => void }) {
  const line = lockoutLine(flow) ?? "PIN locked";
  usePhysicalKeys("digits", { onEnter: onDone, onEscape: onDone });
  return <div className="wk-result" data-tone="error" data-state="pin_locked" role="status">
    <div className="wk-ring wk-ring-error" aria-hidden="true" />
    <h1 className="wk-title">PIN locked</h1>
    <p className="wk-result-name">{memberName(flow.member)}</p>
    <p className="wk-sub">Too many wrong tries. Ask an Operator to unlock it, or try again later.</p>
    <p className="wk-note wk-note-error" role="alert">{line}</p>
    <div className="wk-actions"><button type="button" className="wk-button wk-button-primary" onClick={onDone}>Done</button></div>
  </div>;
}

export function NoPinView({ flow, onAsk, onCancel }: { flow: Step<"no_pin">; onAsk: () => void; onCancel: () => void }) {
  usePhysicalKeys("digits", { onEnter: flow.asking ? undefined : onAsk, onEscape: onCancel });
  return <div className="wk-centered" data-state="no_pin">
    <h1 className="wk-title">You don't have a PIN yet</h1>
    <p className="wk-result-name">{memberName(flow.member)}</p>
    <p className="wk-sub">An Operator needs to approve setting one up.</p>
    {flow.error && <p className="wk-note wk-note-error" role="alert">{flow.error}</p>}
    <div className="wk-actions">
      <button type="button" className="wk-button" onClick={onCancel}>Cancel</button>
      <button type="button" className="wk-button wk-button-primary" disabled={flow.asking} onClick={onAsk}>{flow.asking ? "Asking…" : "Ask for approval"}</button>
    </div>
  </div>;
}

export function WaitingView({ flow, onCancel }: { flow: Step<"waiting">; onCancel: () => void }) {
  usePhysicalKeys("digits", { onEscape: onCancel });
  return <div className="wk-centered" data-state="waiting">
    <div className="wk-ring wk-ring-processing" aria-hidden="true" />
    <h1 className="wk-title">You don't have a PIN yet</h1>
    <p className="wk-result-name">{memberName(flow.member)}</p>
    <p className="wk-note wk-note-warning" role="status">Waiting for an Operator · or an Operator can approve here from maintenance</p>
    <div className="wk-actions"><button type="button" className="wk-button" onClick={onCancel}>Cancel</button></div>
  </div>;
}

/** A PIN typed twice. `first` is the first entry, held only in memory until the second matches. */
export function ChoosePinPad({ first, error, onSubmit, onCancel, busy, hint }: { first?: string; error?: string; onSubmit: (pin: string) => void; onCancel: () => void; busy?: boolean; hint?: string }) {
  const note = hint && <p className="wk-sub">{hint}</p>;
  return first === undefined
    ? <PinPad key="first" title="Choose a PIN" detail="4 to 6 digits. You'll type it twice." error={error} note={note} onSubmit={onSubmit} onCancel={onCancel} submitLabel="Next" {...pinPadLimits} />
    : <PinPad key="second" title="Type the PIN again" detail="To make sure it's right." onSubmit={onSubmit} onCancel={onCancel} submitLabel={busy ? "Saving…" : "Save"} busy={busy} {...pinPadLimits} />;
}

// ---- Maintenance: Set member PIN and Reset member PIN ----

type MaintenanceStage =
  | { name: "first"; member: KioskMember; error?: string }
  | { name: "second"; member: KioskMember; first: string }
  | { name: "confirm_reset"; member: KioskMember }
  | { name: "busy"; member: KioskMember }
  | { name: "done"; title: string; detail?: string; error?: boolean };

function maintenanceError(error: unknown, member: KioskMember) {
  if (error instanceof KioskNetworkError) return offlinePinMaintenanceMessage;
  if (error instanceof KioskApiError) {
    if (error.code === "pin_already_set") return `${memberName(member)} already has a PIN. Reset it first.`;
    if (error.code === "pin_not_required") return "This kiosk doesn't require a PIN. Turn on Require PIN on Manage kiosk first.";
    if (error.code === "member_not_found") return "That member isn't on the active roster.";
    return error.message || "That didn't work. Try again.";
  }
  return "That didn't work. Try again.";
}

/**
 * An Operator in maintenance picks a member the way this kiosk looks members up, then either has the member type a
 * new PIN twice (`POST /kiosk/pins`) or confirms a reset (`POST /kiosk/pins/:memberId/reset`). Both need the network.
 */
export function MemberPinMaintenance({ task, api, roster, lookup, online, onChanged, onBack }: {
  task: "set" | "reset"; api: KioskApi; roster: RosterMember[] | undefined; lookup: MemberLookup; online: boolean | undefined;
  onChanged: () => void; onBack: () => void;
}) {
  const [pick, dispatch] = useReducer(flowReducer, initialFlow);
  const [stage, setStage] = useState<MaintenanceStage>();
  const heading = task === "set" ? "Set member PIN" : "Reset member PIN";

  if (online === false && stage?.name !== "done") return <CenteredMessage title={heading} detail={offlinePinMaintenanceMessage}><BackButton onBack={onBack} /></CenteredMessage>;
  if (!roster) return <CenteredMessage title={heading} detail="The roster hasn't loaded yet."><BackButton onBack={onBack} /></CenteredMessage>;

  async function run(member: KioskMember, action: () => Promise<{ title: string; detail?: string }>) {
    setStage({ name: "busy", member });
    try { const done = await action(); onChanged(); setStage({ name: "done", ...done }); }
    catch (error) { setStage({ name: "done", title: "Couldn't change the PIN", detail: maintenanceError(error, member), error: true }); }
  }
  function typed(pin: string) {
    if (stage?.name !== "first" && stage?.name !== "second") return;
    const step = choosePinStep(stage.name === "second" ? stage.first : undefined, pin);
    if ("problem" in step) setStage({ name: "first", member: stage.member, error: step.problem });
    else if ("first" in step) setStage({ name: "second", member: stage.member, first: step.first });
    else { const member = stage.member; void run(member, async () => { await api.setMemberPin(member.memberId, step.pin); return { title: "PIN set", detail: `${memberName(member)} can now sign in with their PIN.` }; }); }
  }

  if (stage?.name === "done") return <CenteredMessage title={stage.title} detail={stage.detail}><BackButton onBack={onBack} primary /></CenteredMessage>;
  if (stage?.name === "busy") return <CenteredMessage title={task === "set" ? "Saving the PIN" : "Resetting the PIN"} detail={memberName(stage.member)} />;
  if (stage?.name === "first" || stage?.name === "second") return <div data-state="maintenance_pin">
    <ChoosePinPad first={stage.name === "second" ? stage.first : undefined} error={stage.name === "first" ? stage.error : undefined} onSubmit={typed} onCancel={onBack} hint={stage.name === "first" ? `${memberName(stage.member)} · Hand the kiosk to the member` : undefined} />
  </div>;
  if (stage?.name === "confirm_reset") {
    const member = stage.member;
    return <CenteredMessage title={`Reset ${memberName(member)}'s PIN?`} detail="Their PIN is removed. They set a new one next time, with an Operator's approval.">
      <div className="wk-actions">
        <button type="button" className="wk-button" onClick={onBack}>Cancel</button>
        <button type="button" className="wk-button wk-button-danger" onClick={() => void run(member, async () => {
          const reset = await api.resetMemberPin(member.memberId);
          return reset ? { title: "PIN reset", detail: `${memberName(member)} sets a new PIN next time.` } : { title: "No PIN to reset", detail: `${memberName(member)} doesn't have a PIN.` };
        })}>Reset PIN</button>
      </div>
    </CenteredMessage>;
  }
  if (pick.step === "confirm") {
    const member = pick.member;
    return <CenteredMessage title={heading} detail="Is this the member?">
      <div className="wk-person"><b>{memberName(member)}</b><small>Member ID {member.memberId}</small></div>
      <div className="wk-actions">
        <button type="button" className="wk-button" onClick={() => dispatch({ type: "not_me" })}>Back</button>
        <button type="button" className="wk-button wk-button-primary" onClick={() => setStage(task === "set" ? { name: "first", member } : { name: "confirm_reset", member })}>Continue</button>
      </div>
    </CenteredMessage>;
  }
  if (pick.step === "result") return <CenteredMessage title={pick.display.message} detail={pick.display.detail}>
    <div className="wk-actions"><button type="button" className="wk-button" onClick={onBack}>Cancel</button><button type="button" className="wk-button wk-button-primary" onClick={() => dispatch({ type: "reset" })}>Try again</button></div>
  </CenteredMessage>;
  const text = pick.step === "entry" ? pick.text : "";
  return lookup === "search"
    ? <SearchView text={text} roster={roster} dispatch={dispatch} title={heading} onCancel={onBack} />
    : <EntryView text={text} roster={roster} dispatch={dispatch} title={<>{heading}<br />Member ID</>} onCancel={onBack} />;
}

function BackButton({ onBack, primary }: { onBack: () => void; primary?: boolean }) {
  usePhysicalKeys("digits", { onEnter: onBack, onEscape: onBack });
  return <div className="wk-actions"><button type="button" className={`wk-button${primary ? " wk-button-primary" : ""}`} onClick={onBack}>Back to maintenance</button></div>;
}
