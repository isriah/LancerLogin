// On-screen keypad and keyboard, so the kiosk never depends on a system keyboard popping up.
import { useEffect, useRef, type ReactNode } from "react";
import { physicalKeyFor, type KeyCharset } from "./kiosk-flow.ts";

// Keeping focus where it is means a physical keyboard keeps typing into the field after a tap.
const keepFocus = (event: { preventDefault(): void }) => event.preventDefault();

function Key({ label, onPress, className = "", aria, disabled }: { label: ReactNode; onPress: () => void; className?: string; aria?: string; disabled?: boolean }) {
  return <button type="button" className={`wk-key ${className}`} aria-label={aria} disabled={disabled} onMouseDown={keepFocus} onClick={onPress}>{label}</button>;
}

export function Keypad({ onDigit, onClear, onEnter, clearLabel = "Clear", enterLabel = "Enter", enterDisabled }: { onDigit: (digit: string) => void; onClear: () => void; onEnter: () => void; clearLabel?: string; enterLabel?: string; enterDisabled?: boolean }) {
  return <div className="wk-keypad" role="group" aria-label="Keypad">
    {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => <Key key={digit} label={digit} onPress={() => onDigit(digit)} />)}
    <Key label={clearLabel} className="wk-key-wide" onPress={onClear} />
    <Key label="0" onPress={() => onDigit("0")} />
    <Key label={enterLabel} className="wk-key-wide wk-key-go" onPress={onEnter} disabled={enterDisabled} />
  </div>;
}

const letterRows = ["1234567890", "QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM"];

/**
 * A QWERTY keyboard. `lowercase` types lowercase letters (search); otherwise uppercase (member IDs, pairing codes).
 * `characters` limits the keys to those characters (a pairing code has no 0, O, 1 or I).
 */
export function Keyboard({ onKey, onBackspace, onEnter, onClear, enterLabel = "Enter", enterDisabled, space, symbols = true, lowercase, characters }: { onKey: (key: string) => void; onBackspace: () => void; onEnter?: () => void; onClear?: () => void; enterLabel?: string; enterDisabled?: boolean; space?: boolean; symbols?: boolean; lowercase?: boolean; characters?: string }) {
  const type = (key: string) => onKey(lowercase ? key.toLowerCase() : key);
  const rows = characters ? letterRows.map((row) => [...row].filter((key) => characters.includes(key)).join("")) : letterRows;
  return <div className="wk-keyboard" role="group" aria-label="Keyboard">
    {rows.map((row, index) => <div className="wk-keyboard-row" key={row}>
      {[...row].map((key) => <Key key={key} label={lowercase ? key.toLowerCase() : key} onPress={() => type(key)} />)}
      {index === 2 && symbols && <Key label="-" onPress={() => onKey("-")} />}
      {index === 3 && symbols && <><Key label="." onPress={() => onKey(".")} /><Key label="@" onPress={() => onKey("@")} /></>}
      {index === 3 && <Key label="⌫" aria="Backspace" className="wk-key-wide" onPress={onBackspace} />}
    </div>)}
    {(onClear || space || onEnter) && <div className="wk-keyboard-row">
      {onClear && <Key label="Clear" className="wk-key-wide" onPress={onClear} />}
      {space && <Key label="Space" className="wk-key-space" onPress={() => onKey(" ")} />}
      {onEnter && <Key label={enterLabel} className="wk-key-wide wk-key-go" onPress={onEnter} disabled={enterDisabled} />}
    </div>}
  </div>;
}

export type PhysicalKeyHandlers = { onCharacter?: (character: string) => void; onBackspace?: () => void; onEnter?: () => void; onEscape?: () => void };

/**
 * Lets a physical keyboard drive the screen as the on-screen keys do: characters the field takes, Backspace, Enter and
 * Escape. Handled keys are kept from the focused field, so nothing is typed twice; shortcuts and unhandled keys pass through.
 */
export function usePhysicalKeys(charset: KeyCharset, handlers: PhysicalKeyHandlers) {
  const current = useRef({ charset, handlers }); current.current = { charset, handlers };
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented) return;
      const key = physicalKeyFor(event, current.current.charset);
      const { onCharacter, onBackspace, onEnter, onEscape } = current.current.handlers;
      const run = !key ? undefined : key.type === "character" ? onCharacter && (() => onCharacter(key.character)) : key.type === "backspace" ? onBackspace : key.type === "enter" ? onEnter : onEscape;
      if (!key || !run) {
        // A character the screen doesn't take mustn't reach a focused field either (a letter in a numeric member ID).
        if (onCharacter && !event.ctrlKey && !event.altKey && !event.metaKey && [...event.key].length === 1) event.preventDefault();
        return;
      }
      event.preventDefault();
      // Holding Enter or Escape mustn't submit or cancel over and over.
      if (event.repeat && (key.type === "enter" || key.type === "escape")) return;
      run();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
