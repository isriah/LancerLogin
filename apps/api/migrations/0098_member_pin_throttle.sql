-- The online member PIN throttle, separate from the optional lockout. throttle_failures counts wrong PINs checked online
-- in a row since the last correct PIN or Operator unlock; tries reported from offline checks never count. Past the free
-- tries, each wrong PIN sets throttle_until, and a try before then is refused without checking the PIN.
-- Additive: the previously deployed Worker never reads these columns, and its writes leave them as they are. Neither
-- column is in backups or in the kiosk roster, and changing them does not bump the kiosk roster revision (the member_pins
-- update trigger names its columns).
ALTER TABLE member_pins ADD COLUMN throttle_failures INTEGER NOT NULL DEFAULT 0 CHECK (throttle_failures >= 0);
ALTER TABLE member_pins ADD COLUMN throttle_until TEXT;
