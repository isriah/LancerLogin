-- Strictly bounded operational diagnostics. SSIDs, credentials, raw scans, and biometric data are never stored.
ALTER TABLE kiosks ADD COLUMN uptime_seconds INTEGER CHECK (uptime_seconds >= 0);
ALTER TABLE kiosks ADD COLUMN network_type TEXT CHECK (network_type IN ('wifi', 'ethernet', 'offline'));
ALTER TABLE kiosks ADD COLUMN network_signal INTEGER CHECK (network_signal BETWEEN 0 AND 100);
ALTER TABLE kiosks ADD COLUMN last_wifi_scan_at TEXT;
