import { useEffect, useState } from "react";
import { api } from "./dashboard-api";
import { createSingleFlight, releaseCacheForChannel, releaseCacheKeyForChannel, type ReleaseSnapshot } from "./update-release";
import type { UpdateChannel } from "../../../packages/shared/src/release-policy.mjs";
export type UpdateChannelSetting = { channel: UpdateChannel; revision: number };
export const channelNoticeKey = "lancerlogin-update-channel-notice";
export const channelNoticeEvent = "lancerlogin-update-channel-changed";
export const readUpdateChannelSetting = createSingleFlight(async () => {
  const setting = await api<UpdateChannelSetting>("/admin/update-channel");
  if (!["stable", "beta"].includes(setting.channel) || !Number.isSafeInteger(setting.revision)) throw new Error("Update track could not be confirmed.");
  return setting;
});
export function announceUpdateChannelChange() {
  // This marker only asks other tabs to reload server settings. It cannot select a track.
  try { localStorage.setItem(channelNoticeKey, crypto.randomUUID()); } catch { /* Storage is optional. */ }
  window.dispatchEvent(new Event(channelNoticeEvent));
}
export function useReleaseCheck() {
  const [channel, setChannel] = useState<UpdateChannel>();
  const [state, setState] = useState<ReleaseSnapshot>({ checking: true, fresh: false });
  const cache = releaseCacheForChannel(channel ?? "stable");
  useEffect(() => {
    let active = true;
    const update = () => { if (active && channel) setState(cache.snapshot()); };
    const refresh = async () => {
      try {
        const setting = await readUpdateChannelSetting();
        if (!active) return;
        if (channel !== setting.channel) { setState({ checking: true, fresh: false }); setChannel(setting.channel); return; }
        update(); await cache.check();
      } catch (error) { if (active) setState((value) => ({ ...value, fresh: false, checking: false, error: (error as Error).message })); }
    };
    const changed = () => { setState({ checking: true, fresh: false }); void refresh(); };
    const onStorage = (event: StorageEvent) => {
      if (event.key === channelNoticeKey) changed();
      else if (channel && event.key === releaseCacheKeyForChannel(channel)) { cache.sync(); update(); }
    };
    window.addEventListener("storage", onStorage); window.addEventListener(channelNoticeEvent, changed);
    const unsubscribe = cache.subscribe(update); void refresh();
    const timer = window.setInterval(() => void refresh(), 30_000);
    return () => { active = false; unsubscribe(); window.removeEventListener("storage", onStorage); window.removeEventListener(channelNoticeEvent, changed); window.clearInterval(timer); };
  }, [channel, cache]);
  return { ...state, channel, check: async (force = false) => {
    const setting = await readUpdateChannelSetting();
    if (channel !== setting.channel) { setState({ checking: true, fresh: false }); setChannel(setting.channel); }
    return releaseCacheForChannel(setting.channel).check(force);
  } };
}
