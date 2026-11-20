// The Discord code screens: the code entry a Discord code kiosk starts at, and "Code not recognized".
import { discordCodeLength } from "./kiosk-flow.ts";
import type { FlowDispatch } from "./lookup-views.tsx";
import { Keypad, usePhysicalKeys } from "./on-screen-keys.tsx";

/**
 * Six boxes and the keypad. Unlike a PIN the digits are shown: a code works once and expires in 2 minutes. Enter sends
 * the code at exactly six digits. `backupLabel` adds the button that opens the backup method (a kiosk that offers it
 * at any time).
 */
export function DiscordCodeView({ digits, dispatch, onSubmit, backupLabel, onBackup }: { digits: string; dispatch: FlowDispatch; onSubmit: (code: string) => void; backupLabel?: string; onBackup?: () => void }) {
  const complete = digits.length === discordCodeLength;
  const submit = () => { if (complete) onSubmit(digits); };
  const type = (key: string) => dispatch({ type: "key", key });
  usePhysicalKeys("digits", { onCharacter: type, onBackspace: () => dispatch({ type: "backspace" }), onEnter: submit });
  return <div className="wk-split" data-state="code">
    <div className="wk-split-left">
      <h1 className="wk-title">Enter your Discord code</h1>
      <p className="wk-sub">Run /code in the team Discord to get one.</p>
      <div className="wk-code" role="img" aria-label={digits ? `Code so far: ${[...digits].join(" ")}` : "No digits entered"}>
        {Array.from({ length: discordCodeLength }, (_, index) => <span key={index} className={index === digits.length ? "wk-code-next" : ""}>{digits[index] ?? ""}</span>)}
      </div>
      {backupLabel && onBackup && <button type="button" className="wk-button" onClick={onBackup}>{backupLabel}</button>}
    </div>
    <Keypad onDigit={type} onClear={() => dispatch({ type: "clear" })} onEnter={submit} enterDisabled={!complete} />
  </div>;
}

export function CodeInvalidView({ onTryAgain }: { onTryAgain: () => void }) {
  usePhysicalKeys("digits", { onEnter: onTryAgain, onEscape: onTryAgain });
  return <div className="wk-result" data-tone="error" data-state="code_invalid" role="status">
    <div className="wk-ring wk-ring-error" aria-hidden="true" />
    <h1 className="wk-title">Code not recognized</h1>
    <p className="wk-sub">Codes work once and expire after 2 minutes. Run /code again for a new one.</p>
    <div className="wk-actions"><button type="button" className="wk-button wk-button-primary" onClick={onTryAgain}>Try again</button></div>
  </div>;
}
