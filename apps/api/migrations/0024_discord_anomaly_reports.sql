-- Deliver one retry-safe anomaly report per newly eligible meeting to a separate private Discord channel.
ALTER TABLE organization_settings
ADD COLUMN discord_anomaly_reports_enabled INTEGER NOT NULL DEFAULT 0
CHECK (discord_anomaly_reports_enabled IN (0, 1));

ALTER TABLE organization_settings ADD COLUMN discord_anomaly_report_channel_id TEXT;
ALTER TABLE organization_settings ADD COLUMN discord_anomaly_reports_enabled_at TEXT;

CREATE TABLE discord_anomaly_reports (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'no_anomalies', 'failed')),
  nonce TEXT NOT NULL CHECK (length(nonce) BETWEEN 1 AND 25),
  message_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  processed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (installation_id, meeting_id)
);

CREATE INDEX idx_discord_anomaly_reports_status
ON discord_anomaly_reports (installation_id, status, updated_at);
