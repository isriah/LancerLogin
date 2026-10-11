import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { readUpdateChannelSetting, announceUpdateChannelChange, channelNoticeEvent, channelNoticeKey, type UpdateChannelSetting } from "./use-release-check";
import type { UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
export function UpdateChannelCard() {
  const [setting, setSetting] = useState<UpdateChannelSetting>(); const [choice, setChoice] = useState<UpdateChannel>("stable");
  const [confirmed, setConfirmed] = useState(false); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState("");
  const currentSetting = useRef<UpdateChannelSetting | undefined>(undefined);
  function acceptSetting(value: UpdateChannelSetting) {
    const previous = currentSetting.current;
    if (previous && value.revision <= previous.revision) return;
    currentSetting.current = value;
    setSetting(value);
    setChoice((draft) => !previous || draft === previous.channel ? value.channel : draft);
    setConfirmed(false);
    if (previous) setNotice("The installation update track changed. Review your selection before saving.");
  }
  useEffect(() => {
    let active = true;
    const refresh = () => { void readUpdateChannelSetting().then((value) => { if (active) acceptSetting(value); }).catch((error: Error) => { if (active) setNotice(error.message); }); };
    const onStorage = (event: StorageEvent) => { if (event.key === channelNoticeKey) refresh(); };
    refresh();
    window.addEventListener(channelNoticeEvent, refresh);
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(refresh, 30_000);
    return () => { active = false; window.removeEventListener(channelNoticeEvent, refresh); window.removeEventListener("storage", onStorage); window.clearInterval(timer); };
  }, []);
  async function save() {
    if (!setting) return; setBusy(true); setNotice("");
    try {
      const value = await api<UpdateChannelSetting>("/admin/update-channel", { method: "PUT", body: JSON.stringify({ channel: choice, revision: setting.revision, betaConfirmed: confirmed }) });
      currentSetting.current = value; setSetting(value); setChoice(value.channel); setConfirmed(false); announceUpdateChannelChange(); setNotice("Update track saved. No update was started.");
    } catch (error) {
      setNotice((error as Error).message);
      const value = await readUpdateChannelSetting().catch(() => undefined); if (value) acceptSetting(value);
    } finally { setBusy(false); }
  }
  return <article className="ui-card update-channel-card" aria-labelledby="update-channel-title"><h2 id="update-channel-title">Update track</h2>
    <p id="update-channel-help">Stable is recommended. Beta includes newer beta and stable releases. Changing tracks does not install an update. Returning to Stable never downgrades: wait for a newer stable release.</p>
    <label htmlFor="update-channel-choice">Installation update track</label><select id="update-channel-choice" aria-describedby="update-channel-help" disabled={!setting || busy} value={choice} onChange={(event) => { setChoice(event.target.value as UpdateChannel); setConfirmed(false); }}><option value="stable">Stable</option><option value="beta">Beta</option></select>
    {choice === "beta" && setting?.channel !== "beta" && <label className="checkbox-field"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} />I understand beta releases may be unstable and automatic downgrades are not supported.</label>}
    <div><button type="button" className="ui-button ui-button--primary" disabled={busy || !setting || choice === setting.channel || choice === "beta" && !confirmed} onClick={() => void save()}>{busy ? "Saving…" : "Save update track"}</button></div>
    {notice && <p className="ui-status" role="status">{notice}</p>}
  </article>;
}
