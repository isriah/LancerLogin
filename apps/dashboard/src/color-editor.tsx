import { useEffect, useState } from "react";

const normalizeHex = (input: string) => {
  const value = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(value)) return `#${[...value].map((channel) => `${channel}${channel}`).join("")}`.toLowerCase();
  return /^[0-9a-f]{6}$/i.test(value) ? `#${value.toLowerCase()}` : undefined;
};

const hexToRgb = (hex: string) => [1, 3, 5].map((start) => Number.parseInt(hex.slice(start, start + 2), 16));
const rgbToHex = (channels: number[]) => `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;

export function ColorEditor({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  const normalizedValue = normalizeHex(value) ?? "#000000";
  const [hex, setHex] = useState(normalizedValue);
  const [rgb, setRgb] = useState(() => hexToRgb(normalizedValue).map(String));
  const [error, setError] = useState("");

  useEffect(() => { setHex(normalizedValue); setRgb(hexToRgb(normalizedValue).map(String)); setError(""); }, [normalizedValue]);

  function changeHex(next: string) {
    setHex(next);
    const parsed = normalizeHex(next);
    if (!parsed) { setError("Enter a three- or six-digit hexadecimal color."); return; }
    setError(""); setRgb(hexToRgb(parsed).map(String)); onChange(parsed);
  }

  function changeRgb(index: number, next: string) {
    const channels = [...rgb]; channels[index] = next; setRgb(channels);
    const parsed = channels.map((channel) => Number(channel));
    if (channels.some((channel) => channel.trim() === "") || parsed.some((channel) => !Number.isInteger(channel) || channel < 0 || channel > 255)) { setError("RGB channels must be whole numbers from 0 to 255."); return; }
    const nextHex = rgbToHex(parsed); setError(""); setHex(nextHex); onChange(nextHex);
  }

  function slide(index: number, next: string) {
    const channels = [...rgb]; channels[index] = next; setRgb(channels);
    const parsed = channels.map((channel) => Math.min(255, Math.max(0, Number(channel) || 0)));
    const nextHex = rgbToHex(parsed); setError(""); setHex(nextHex); onChange(nextHex);
  }

  return <details className="color-editor">
    <summary><span>{label}</span><span className="color-summary-value"><i style={{ background: normalizedValue }} aria-hidden="true" /><code>{normalizedValue.toUpperCase()}</code></span></summary>
    <div className="color-editor-panel">
      <div className="color-swatch" style={{ background: normalizedValue }} aria-label={`${label} preview`} />
      <label>Hex<input value={hex} onChange={(event) => changeHex(event.target.value)} spellCheck={false} aria-invalid={Boolean(error)} /></label>
      <fieldset><legend>RGB channels</legend>{(["Red", "Green", "Blue"] as const).map((channel, index) => <div className="rgb-channel" key={channel}><label>{channel}<input type="number" min={0} max={255} step={1} value={rgb[index]} onChange={(event) => changeRgb(index, event.target.value)} aria-invalid={Boolean(error)} /></label><input aria-label={`${channel} slider`} type="range" min={0} max={255} step={1} value={Number(rgb[index]) || 0} onChange={(event) => slide(index, event.target.value)} /></div>)}</fieldset>
      {error && <p className="inline-field-error" role="alert">{error}</p>}
    </div>
  </details>;
}
