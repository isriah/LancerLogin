-- Remove the browser simulator (web kiosk phase 5). Web kiosks and the virtual Pi replace it, and Attendance setup's
-- Verified attendance input step now completes once a paired kiosk, Pi or web, has checked in.
-- pairing_codes.purpose keeps its CHECK ('hardware', 'simulator'), since changing it needs a table rebuild; the Worker
-- just stops creating simulator codes. attendance_events.source keeps 'simulator' for earlier setup check-ins.
-- The previously deployed Worker reads simulated_kiosk_sessions only on the Simulator page, the Kiosks page's Browser
-- simulator card, when Attendance is disabled and in backups, so those fail until the new Worker is serving.
DROP TABLE IF EXISTS simulated_kiosk_sessions;

-- Simulator codes were created already redeemed and never paired a kiosk.
DELETE FROM pairing_codes WHERE purpose = 'simulator' AND id NOT IN (SELECT pairing_code_id FROM kiosks);

-- The Simulator page's walkthrough is gone with the page.
DELETE FROM user_walkthroughs WHERE page_id = 'simulator';
