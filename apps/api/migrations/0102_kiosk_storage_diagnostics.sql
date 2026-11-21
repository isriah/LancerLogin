-- Local state a Raspberry Pi kiosk had to repair, as it reported it in its last heartbeat: a network settings PIN restored
-- from its backup copy or unreadable, and unreadable queue entries it set aside. One JSON object, rewritten by the
-- heartbeat's existing kiosk update, so the heartbeat costs no extra query. NULL when there is nothing to show, for kiosks
-- before 2.1.0-beta.11 and for web kiosks.
-- Additive: the previously deployed Worker never reads this column, and its heartbeat update leaves it at its value.
ALTER TABLE kiosks ADD COLUMN storage_diagnostics TEXT;
