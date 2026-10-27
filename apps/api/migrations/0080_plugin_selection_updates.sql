-- A web update request either installs a newer official release ('release') or redeploys the installed release with the
-- private repository's changed plugin selection ('modules'). module_selection_sha pins the git blob of
-- lancerlogin.modules.json that a request applies (forty zeros when the file is absent); the controller refuses to deploy
-- any other selection. It is NULL only when the installation has no plugin selection credential to read the file with.
-- Existing rows and older running code keep the default 'release' mode.
ALTER TABLE web_update_requests ADD COLUMN mode TEXT NOT NULL DEFAULT 'release' CHECK (mode IN ('release', 'modules'));
ALTER TABLE web_update_requests ADD COLUMN module_selection_sha TEXT CHECK (module_selection_sha IS NULL OR (length(module_selection_sha) = 40 AND module_selection_sha NOT GLOB '*[^0-9a-f]*'));
