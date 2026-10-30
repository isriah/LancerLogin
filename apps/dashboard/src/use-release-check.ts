import { useEffect, useRef, useState } from "react";
import { api } from "./dashboard-api";
import { visiblePoll } from "./visible-poll";
import { createCachedRead, releaseCacheForChannel, releaseCacheKeyForChannel, type ReleaseSnapshot } from "./update-release";
import type { UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
export type UpdateChannelSetting = { channel: UpdateChannel; revision: number };
export const channelNoticeKey = "lancerlogin-update-channel-notice";
export const channelNoticeEvent = "lancerlogin-update-channel-changed";
/** The header check, the release check and the Update track card read the track together; one request serves them for a few seconds. A change notice always reads the server again. */
export const readUpdateChannelSetting = createCachedRead(async () => {
  const setting = await api<UpdateChannelSetting>("/admin/update-channel");
  if (!["stable", "beta"].includes(setting.channel) || !Number.isSafeInteger(setting.revision)) throw new Error("Update track could not be confirmed.");
  return setting;
}, 5_000);
// Registered before any view's listener, so every view that reacts to another tab's notice reads the new setting.
if (typeof window !== "undefined") window.addEventListener("storage", (event) => { if (event.key === channelNoticeKey) readUpdateChannelSetting.invalidate(); });
export function announceUpdateChannelChange() {
  readUpdateChannelSetting.invalidate();
  // This marker only asks other tabs to reload server settings. It cannot select a track.
  try { localStorage.setItem(channelNoticeKey, crypto.randomUUID()); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new Event(channelNoticeEvent));
}
/** Track the latest release on the installation's update track. Polls serially and pauses while the tab is hidden. */
export function useReleaseCheck(enabled = true) {
  const [channel, setChannel] = useState<UpdateChannel>();
  const [state, setState] = useState<ReleaseSnapshot>({ checking: true, fresh: false });
  // The confirmed track. Both release caches are watched, so learning or changing the track needs no second effect pass.
  const current = useRef<UpdateChannel>(undefined);
  const select = (next: UpdateChannel) => { if (current.current === next) return; current.current = next; setChannel(next); };
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const update = () => { if (active && current.current) setState(releaseCacheForChannel(current.current).snapshot()); };
    const refresh = async () => {
      try {
        const setting = await readUpdateChannelSetting();
        if (!active) return;
        select(setting.channel); update(); await releaseCacheForChannel(setting.channel).check();
      } catch (error) { if (active) setState((value) => ({ ...value, fresh: false, checking: false, error: (error as Error).message })); }
    };
    const changed = () => { setState({ checking: true, fresh: false }); void refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === channelNoticeKey) changed();
      else if (current.current && event.key === releaseCacheKeyForChannel(current.current)) { releaseCacheForChannel(current.current).sync(); update(); }
    };
    window.addEventListener("storage", onStorage); window.addEventListener(channelNoticeEvent, changed);
    const unsubscribe = (["stable", "beta"] as const).map((track) => releaseCacheForChannel(track).subscribe(() => { if (track === current.current) update(); }));
    const stop = visiblePoll(refresh, 30_000, undefined, true);
    return () => { active = false; unsubscribe.forEach((leave) => leave()); window.removeEventListener("storage", onStorage); window.removeEventListener(channelNoticeEvent, changed); stop(); };
  }, [enabled]);
  return { ...state, channel, check: async (force = false) => {
    const setting = await readUpdateChannelSetting();
    if (current.current !== setting.channel) { setState({ checking: true, fresh: false }); select(setting.channel); }
    return releaseCacheForChannel(setting.channel).check(force);
  } };
}
