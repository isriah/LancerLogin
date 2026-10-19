import { AttendanceSettingsSections } from "./settings-section-navigation";
import { FingerprintSyncSettings } from "./fingerprint-sync-settings";
import "./mobile-kiosks.css";

export function FingerprintSharingPage() {
  return <section className="settings-page fingerprint-sharing-page" aria-labelledby="fingerprint-sharing-title">
    <div className="page-intro"><h1 id="fingerprint-sharing-title">Fingerprint sharing</h1></div>
    <AttendanceSettingsSections />
    <FingerprintSyncSettings />
  </section>;
}
