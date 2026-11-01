-- Web kiosks: a page on the dashboard site that pairs with an 8-character one-time code and identifies members by
-- member ID, typed or found by searching the roster. A Pi is kind 'pi'.
-- Member search is a lookup style of the existing member_id method, so the authentication method CHECK constraints
-- stay as they are. member_lookup matters only while the configured method is member_id.
-- Additive: the previously deployed Worker never reads these columns, its inserts get the defaults, and every kiosk
-- and pairing code it knows is a Pi one.
ALTER TABLE kiosks ADD COLUMN kind TEXT NOT NULL DEFAULT 'pi' CHECK (kind IN ('pi', 'web'));
ALTER TABLE kiosks ADD COLUMN member_lookup TEXT NOT NULL DEFAULT 'entry' CHECK (member_lookup IN ('entry', 'search'));

-- A web code carries the name the Admin chose; a Pi still sends its own name when it pairs.
ALTER TABLE pairing_codes ADD COLUMN kiosk_kind TEXT NOT NULL DEFAULT 'pi' CHECK (kiosk_kind IN ('pi', 'web'));
ALTER TABLE pairing_codes ADD COLUMN kiosk_name TEXT;
