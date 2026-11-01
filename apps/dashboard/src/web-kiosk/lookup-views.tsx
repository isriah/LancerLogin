// Finding a member: member ID entry (keypad or keyboard) and member search. Used by the attendance steps and by the
// maintenance screens that set or reset a member's PIN.
import { useMemo, type ReactNode } from "react";
import { searchMembers } from "../../../../packages/shared/src/member-lookup.mjs";
import type { RosterMember } from "./kiosk-api.ts";
import { entryInputFor, maxSearchResults, memberName, type flowReducer } from "./kiosk-flow.ts";
import { Keyboard, Keypad, usePhysicalKeys } from "./on-screen-keys.tsx";

export type FlowDispatch = (action: Parameters<typeof flowReducer>[1]) => void;
type LookupProps = { text: string; roster: RosterMember[]; dispatch: FlowDispatch; title?: ReactNode; onCancel?: () => void };

export function EntryView({ text, roster, dispatch, title, onCancel }: LookupProps) {
  const input = entryInputFor(roster);
  const submit = () => dispatch({ type: "submit", roster });
  // Typed letters show uppercase, as on the on-screen keyboard; member IDs match regardless of case.
  usePhysicalKeys(input === "keypad" ? "digits" : "text", { onCharacter: (key) => dispatch({ type: "key", key: key.toUpperCase() }), onBackspace: () => dispatch({ type: "backspace" }), onEnter: submit, onEscape: onCancel });
  const field = <input className="wk-entry" aria-label="Member ID" value={text} inputMode="none" autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus placeholder="Member ID"
    onChange={(event) => dispatch({ type: "set", text: event.target.value })} />;
  const cancel = onCancel && <button type="button" className="wk-button" onClick={onCancel}>Cancel</button>;
  if (input === "keypad") return <div className="wk-split">
    <div className="wk-split-left"><h1 className="wk-title">{title ?? <>Enter your<br />member ID</>}</h1><p className="wk-sub">Then tap Enter</p>{field}{cancel}</div>
    <Keypad onDigit={(digit) => dispatch({ type: "key", key: digit })} onClear={() => dispatch({ type: "clear" })} onEnter={submit} enterDisabled={!text.trim()} />
  </div>;
  return <div className="wk-stack">
    <h1 className="wk-title">{title ?? "Enter your member ID"}</h1>
    {field}
    <Keyboard onKey={(key) => dispatch({ type: "key", key })} onBackspace={() => dispatch({ type: "backspace" })} onClear={() => dispatch({ type: "clear" })} onEnter={submit} enterDisabled={!text.trim()} />
    {cancel}
  </div>;
}

export function SearchView({ text, roster, dispatch, title, onCancel }: LookupProps) {
  const results = useMemo(() => searchMembers(roster, text, { limit: maxSearchResults }), [roster, text]);
  usePhysicalKeys("text", { onCharacter: (key) => dispatch({ type: "key", key }), onBackspace: () => dispatch({ type: "backspace" }), onEnter: () => { if (results[0]) dispatch({ type: "pick", member: results[0] }); }, onEscape: onCancel });
  return <div className="wk-stack wk-search">
    {title && <h1 className="wk-title">{title}</h1>}
    <div className="wk-search-field">
      <span aria-hidden="true">Search</span>
      <input aria-label="Search by name, member ID or email" value={text} inputMode="none" autoComplete="off" spellCheck={false} autoFocus placeholder="Name, ID or email" onChange={(event) => dispatch({ type: "set", text: event.target.value })} />
    </div>
    <div className="wk-results" aria-live="polite">
      {results.map((member) => <button type="button" key={member.memberId} className="wk-result-row" onClick={() => dispatch({ type: "pick", member })}><span>{memberName(member)}</span><small>{member.memberId}</small></button>)}
      {text.trim() && !results.length && <p className="wk-results-empty">No matches. Check the spelling, or ask an operator.</p>}
      {!text.trim() && <p className="wk-results-empty">Type your name, member ID or email.</p>}
    </div>
    <Keyboard lowercase space onKey={(key) => dispatch({ type: "key", key })} onBackspace={() => dispatch({ type: "backspace" })} onClear={() => dispatch({ type: "clear" })} />
    {onCancel && <button type="button" className="wk-button" onClick={onCancel}>Cancel</button>}
  </div>;
}
