import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { networkApp, networkStyles, pressWifiKey, wifiKeyboardRows } from "../apps/kiosk/src/network-ui.mjs";

// The Wi-Fi password keyboard on the kiosk's network settings screen (apps/kiosk/src/network-ui.mjs).
const start = Object.freeze({ layer: "letters", shift: "off" });
const keysOf = (state) => wifiKeyboardRows(state).flat();
const keyOfType = (state, type) => keysOf(state).find((key) => key.type === type);
const characterKey = (state, value) => keysOf(state).find((key) => key.type === "character" && key.value === value);
const printableAscii = Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index));

/** Types text as an operator would, using only keys the keyboard shows: Shift for a capital, the layer key for a symbol. */
function typeText(text, keyboard = { state: start, value: "" }) {
  let { state, value } = keyboard;
  const press = (key) => { assert.ok(key, "the key is on the keyboard"); const result = pressWifiKey(state, key, { value }); state = result.state; value = result.value; };
  for (const character of text) {
    if (!characterKey(state, character)) {
      if (state.layer === "letters" && /[A-Z]/.test(character)) press(keyOfType(state, "shift"));
      else if (state.layer === "letters" && /[a-z]/.test(character)) { while (state.shift !== "off") press(keyOfType(state, "shift")); }
      else press(keyOfType(state, "layer"));
      if (!characterKey(state, character) && /[A-Z]/.test(character)) press(keyOfType(state, "shift"));
      if (!characterKey(state, character) && /[a-z]/.test(character)) { while (state.shift !== "off") press(keyOfType(state, "shift")); }
    }
    press(characterKey(state, character));
  }
  return { state, value };
}

test("the keyboard's layers hold every printable ASCII character", () => {
  const reachable = new Set([start, { layer: "letters", shift: "once" }, { layer: "symbols", shift: "off" }].flatMap((state) => keysOf(state).filter((key) => key.type === "character").map((key) => key.value)));
  assert.deepEqual(printableAscii.filter((character) => !reachable.has(character)), []);
  // Nothing outside printable ASCII, and every key types one character.
  assert.deepEqual([...reachable].filter((character) => !printableAscii.includes(character)), []);
  // Every character can be typed from the starting state, and comes out as itself.
  for (const character of printableAscii) assert.equal(typeText(character).value, character);
  assert.equal(typeText(printableAscii.join("")).value, printableAscii.join(""));
});

test("each layer has the keys an operator needs, and no row is wider than ten keys", () => {
  for (const state of [start, { layer: "letters", shift: "once" }, { layer: "letters", shift: "lock" }, { layer: "symbols", shift: "off" }]) {
    const rows = wifiKeyboardRows(state);
    assert.equal(rows.length, 5);
    for (const row of rows) assert.ok(row.length <= 10);
    const keys = rows.flat();
    // No character appears twice on one layer.
    const values = keys.filter((key) => key.type === "character").map((key) => key.value);
    assert.equal(new Set(values).size, values.length);
    for (const digit of "1234567890") assert.ok(values.includes(digit));
    assert.ok(values.includes(" "));
    assert.equal(keys.filter((key) => key.type === "backspace").length, 1);
    assert.equal(keys.filter((key) => key.type === "layer").length, 1);
    assert.equal(keys.filter((key) => key.type === "shift").length, state.layer === "letters" ? 1 : 0);
  }
  assert.equal(keyOfType(start, "layer").name, "Symbols");
  assert.equal(keyOfType({ layer: "symbols", shift: "off" }, "layer").name, "Letters");
});

test("Shift capitalises one letter, a second tap locks capitals and a third turns them off", () => {
  let keyboard = { state: start, value: "" };
  const press = (key) => { const result = pressWifiKey(keyboard.state, key, { value: keyboard.value }); keyboard = { state: result.state, value: result.value }; };
  assert.deepEqual(pick(keyOfType(start, "shift")), { label: "Shift", name: "Shift", active: false, locked: false });
  assert.ok(characterKey(start, "q") && !characterKey(start, "Q"));

  press(keyOfType(keyboard.state, "shift"));
  assert.equal(keyboard.state.shift, "once");
  assert.deepEqual(pick(keyOfType(keyboard.state, "shift")), { label: "Shift", name: "Shift", active: true, locked: false });
  assert.ok(characterKey(keyboard.state, "Q") && !characterKey(keyboard.state, "q"));
  press(characterKey(keyboard.state, "Q"));
  assert.equal(keyboard.state.shift, "off");
  press(characterKey(keyboard.state, "q"));
  assert.equal(keyboard.value, "Qq");

  press(keyOfType(keyboard.state, "shift")); press(keyOfType(keyboard.state, "shift"));
  assert.equal(keyboard.state.shift, "lock");
  assert.deepEqual(pick(keyOfType(keyboard.state, "shift")), { label: "CAPS", name: "Caps lock", active: true, locked: true });
  press(characterKey(keyboard.state, "A")); press(characterKey(keyboard.state, "B")); press(characterKey(keyboard.state, "1"));
  assert.equal(keyboard.state.shift, "lock");
  // Caps lock survives a visit to the symbols; a single Shift does not.
  press(keyOfType(keyboard.state, "layer")); press(characterKey(keyboard.state, "$")); press(keyOfType(keyboard.state, "layer"));
  assert.deepEqual(keyboard.state, { layer: "letters", shift: "lock" });
  press(characterKey(keyboard.state, "C"));
  press(keyOfType(keyboard.state, "shift"));
  assert.equal(keyboard.state.shift, "off");
  press(characterKey(keyboard.state, "d"));
  assert.equal(keyboard.value, "QqAB1$Cd");

  press(keyOfType(keyboard.state, "shift")); press(keyOfType(keyboard.state, "layer")); press(keyOfType(keyboard.state, "layer"));
  assert.deepEqual(keyboard.state, start);
  // Shift and the layer key never change the text or move the caret.
  assert.deepEqual(pressWifiKey(start, keyOfType(start, "shift"), { value: "abc", start: 1, end: 2 }), { state: { layer: "letters", shift: "once" }, value: "abc" });
  assert.deepEqual(pressWifiKey(start, keyOfType(start, "layer"), { value: "abc", start: 1, end: 2 }), { state: { layer: "symbols", shift: "off" }, value: "abc" });
});
function pick({ label, name, active, locked }) { return { label, name, active, locked }; }

test("keys edit the text at the caret, Backspace removes one character or the selection, and the length limit holds", () => {
  const backspace = keyOfType(start, "backspace"); const x = characterKey(start, "x");
  assert.deepEqual(pressWifiKey(start, backspace, { value: "abc" }), { state: start, value: "ab", caret: 2 });
  assert.deepEqual(pressWifiKey(start, backspace, { value: "abc", start: 1, end: 1 }), { state: start, value: "bc", caret: 0 });
  assert.deepEqual(pressWifiKey(start, backspace, { value: "abc", start: 0, end: 0 }), { state: start, value: "abc", caret: 0 });
  assert.deepEqual(pressWifiKey(start, backspace, { value: "abcd", start: 1, end: 3 }), { state: start, value: "ad", caret: 1 });
  assert.deepEqual(pressWifiKey(start, backspace, { value: "" }), { state: start, value: "", caret: 0 });
  assert.deepEqual(pressWifiKey(start, x, { value: "abc" }), { state: start, value: "abcx", caret: 4 });
  assert.deepEqual(pressWifiKey(start, x, { value: "abc", start: 1, end: 1 }), { state: start, value: "axbc", caret: 2 });
  assert.deepEqual(pressWifiKey(start, x, { value: "abcd", start: 1, end: 3 }), { state: start, value: "axd", caret: 2 });
  // A selection the field no longer has (null from a field type without one) types at the end.
  assert.deepEqual(pressWifiKey(start, x, { value: "abc", start: null, end: null }), { state: start, value: "abcx", caret: 4 });

  // The field takes 128 characters; a full field takes no more and keeps a pending Shift.
  const full = "p".repeat(128);
  assert.equal(pressWifiKey(start, x, { value: full.slice(1) }).value.length, 128);
  assert.deepEqual(pressWifiKey(start, x, { value: full }), { state: start, value: full });
  const shifted = { layer: "letters", shift: "once" };
  assert.deepEqual(pressWifiKey(shifted, characterKey(shifted, "X"), { value: full }), { state: shifted, value: full });
  assert.deepEqual(pressWifiKey(start, x, { value: "abc" }, 3), { state: start, value: "abc" });
  // Replacing a selection in a full field still works.
  assert.equal(pressWifiKey(start, x, { value: full, start: 0, end: 1 }).value, `x${full.slice(1)}`);
});

test("the network page carries the keyboard, a Show/Hide control and touch-sized keys", () => {
  // The page's script parses with the keyboard functions written into it.
  assert.doesNotThrow(() => new vm.Script(networkApp.replace(/^import [^\n]+\n/, "")));
  assert.match(networkApp, /function wifiKeyboardRows\(state\)/);
  assert.match(networkApp, /function pressWifiKey\(state, key, field, maxLength = 128\)/);
  assert.doesNotMatch(networkApp, /qwertyuiopasdfghjklzxcvbnm@/);
  assert.match(networkApp, /id="wifi-password" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="128"/);
  assert.match(networkApp, /id="wifi-password-toggle" type="button" aria-pressed="false" aria-label="Show password">Show</);
  assert.match(networkApp, /shown\?"Hide password":"Show password"/);
  // The password is hidden again, and cleared, whenever the entry is left or a join finishes either way.
  assert.match(networkApp, /function resetPasswordEntry\(\)\{find\("wifi-password"\)\.value="";showPassword\(false\)/);
  assert.equal(networkApp.match(/resetPasswordEntry\(\)/g).length, 6);
  // The password leaves the page only in the join request.
  assert.equal(networkApp.match(/find\("wifi-password"\)\.value(?!=)/g).length, 1);
  assert.doesNotMatch(networkApp, /console\.|localStorage|sessionStorage/);
  assert.match(networkStyles, /\.touch-keyboard button\{[^}]*min-height:clamp\(44px,/);
  assert.match(networkStyles, /@media\(max-height:640px\)\{\.network-panel\.typing/);
  // The settings PIN keypad is as it was.
  assert.match(networkStyles, /\.pin-keypad\{display:grid;grid-template-columns:repeat\(3,1fr\);gap:\.3rem\}\.pin-keypad button\{min-width:0;min-height:54px;padding:\.25rem;font-size:1\.35rem\}\.pin-keypad \.wide\{grid-column:span 2\}/);
});
