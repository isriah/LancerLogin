CREATE TABLE hours_publication_intents (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 activity_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','discord')),
 enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0), needs_review INTEGER NOT NULL DEFAULT 0 CHECK(needs_review IN (0,1)),
 activity_revision INTEGER NOT NULL, actor_user_id TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)),
 updated_at TEXT NOT NULL, PRIMARY KEY(installation_id,activity_id,provider),
 FOREIGN KEY(installation_id,activity_id) REFERENCES hours_activities(installation_id,id) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE hours_publication_generations (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 activity_id TEXT NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('google','discord')), generation INTEGER NOT NULL CHECK(generation>0),
 connection_generation TEXT NOT NULL, destination TEXT NOT NULL, application_id TEXT NOT NULL,
 marker TEXT NOT NULL, provider_event_id TEXT, abandoned INTEGER NOT NULL DEFAULT 0 CHECK(abandoned IN (0,1)),
 created_at TEXT NOT NULL, PRIMARY KEY(installation_id,activity_id,provider,generation), UNIQUE(installation_id,marker),
 FOREIGN KEY(installation_id,activity_id,provider) REFERENCES hours_publication_intents(installation_id,activity_id,provider) ON DELETE CASCADE
);
CREATE TABLE hours_publication_operations (
 installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
 activity_id TEXT NOT NULL, provider TEXT NOT NULL, generation INTEGER NOT NULL,
 action TEXT NOT NULL CHECK(action IN ('upsert','delete')), revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','failed','complete','review')),
 phase TEXT NOT NULL DEFAULT 'ready' CHECK(phase IN ('ready','create_dispatched','known')),
 snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json)), actor_user_id TEXT NOT NULL, activity_revision INTEGER NOT NULL,
 attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0), next_attempt_ms INTEGER NOT NULL DEFAULT 0,
 lease_token TEXT, lease_expires_ms INTEGER, last_error TEXT, updated_at TEXT NOT NULL,
 PRIMARY KEY(installation_id,activity_id,provider,generation,action),
 FOREIGN KEY(installation_id,activity_id,provider,generation) REFERENCES hours_publication_generations(installation_id,activity_id,provider,generation) ON DELETE CASCADE,
 FOREIGN KEY(installation_id,actor_user_id) REFERENCES users(installation_id,id) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX hours_publication_due ON hours_publication_operations(installation_id,provider,status,next_attempt_ms);

-- Preserve published records when content or authority changes. Pending upserts
-- require a fresh review; a processing request retains its lease for late-ID recovery.
CREATE TRIGGER hours_publication_activity_review AFTER UPDATE ON hours_activities
WHEN NEW.revision!=OLD.revision OR NEW.archived!=OLD.archived
BEGIN
 UPDATE hours_publication_intents SET needs_review=1,revision=revision+1 WHERE installation_id=NEW.installation_id AND activity_id=NEW.id AND enabled=1;
 UPDATE hours_publication_operations SET status='review',last_error='Review the changed activity before publishing' WHERE installation_id=NEW.installation_id AND activity_id=NEW.id AND action='upsert' AND status!='complete';
END;
CREATE TRIGGER hours_publication_archive AFTER UPDATE OF archived ON hours_activities
WHEN NEW.archived=1 AND OLD.archived=0
BEGIN
 UPDATE hours_publication_intents SET enabled=0 WHERE installation_id=NEW.installation_id AND activity_id=NEW.id;
 UPDATE hours_publication_generations SET abandoned=1 WHERE installation_id=NEW.installation_id AND activity_id=NEW.id;
 INSERT INTO hours_publication_operations(installation_id,activity_id,provider,generation,action,snapshot_json,actor_user_id,activity_revision,updated_at)
 SELECT g.installation_id,g.activity_id,g.provider,g.generation,'delete',i.snapshot_json,i.actor_user_id,i.activity_revision,i.updated_at FROM hours_publication_generations g JOIN hours_publication_intents i USING(installation_id,activity_id,provider) WHERE g.installation_id=NEW.installation_id AND g.activity_id=NEW.id
 ON CONFLICT(installation_id,activity_id,provider,generation,action) DO NOTHING;
END;
CREATE TRIGGER hours_publication_module_pause AFTER UPDATE OF hours_enabled ON platform_module_configuration
WHEN NEW.hours_enabled=0 AND OLD.hours_enabled=1
BEGIN
 UPDATE hours_publication_intents SET needs_review=1,revision=revision+1 WHERE installation_id=NEW.installation_id AND enabled=1;
 UPDATE hours_publication_operations SET status='review',last_error='Review publication after enabling Hour Tracking' WHERE installation_id=NEW.installation_id AND action='upsert' AND status!='complete';
END;
CREATE TRIGGER hours_publication_provider_pause AFTER UPDATE OF discord_enabled,google_calendar_enabled ON installations
WHEN (NEW.discord_enabled=0 AND OLD.discord_enabled=1) OR (NEW.google_calendar_enabled=0 AND OLD.google_calendar_enabled=1)
BEGIN
 UPDATE hours_publication_intents SET needs_review=1,revision=revision+1 WHERE installation_id=NEW.id AND enabled=1 AND ((provider='discord' AND NEW.discord_enabled=0) OR (provider='google' AND NEW.google_calendar_enabled=0));
 UPDATE hours_publication_operations SET status='review',last_error='Review publication after provider changes' WHERE installation_id=NEW.id AND action='upsert' AND status!='complete' AND ((provider='discord' AND NEW.discord_enabled=0) OR (provider='google' AND NEW.google_calendar_enabled=0));
END;
CREATE TRIGGER hours_publication_discord_rotation AFTER UPDATE OF iv,verified_at ON encrypted_integrations
WHEN NEW.provider='discord' AND (NEW.iv!=OLD.iv OR NEW.verified_at IS NULL)
BEGIN
 UPDATE hours_publication_intents SET needs_review=1,revision=revision+1 WHERE installation_id=NEW.installation_id AND provider='discord' AND enabled=1;
 UPDATE hours_publication_operations SET status='review',last_error='Review publication after provider changes' WHERE installation_id=NEW.installation_id AND provider='discord' AND action='upsert' AND status!='complete';
END;
CREATE TRIGGER hours_publication_google_rotation AFTER UPDATE OF active_iv,grant_error ON google_connections
WHEN NEW.active_iv IS NOT OLD.active_iv OR NEW.grant_error='revoked'
BEGIN
 UPDATE hours_publication_intents SET needs_review=1,revision=revision+1 WHERE installation_id=NEW.installation_id AND provider='google' AND enabled=1;
 UPDATE hours_publication_operations SET status='review',last_error='Review publication after provider changes' WHERE installation_id=NEW.installation_id AND provider='google' AND action='upsert' AND status!='complete';
END;

-- Atomic across installation deletion/restore and scheduler claims. A late remote
-- response must retain its original operation and ownership marker.
CREATE TRIGGER hours_publication_installation_delete_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM hours_publication_operations WHERE installation_id=OLD.id AND (lease_expires_ms>unixepoch('subsec')*1000 OR phase='create_dispatched'))
BEGIN
 SELECT RAISE(ABORT,'hours_publication_in_flight');
END;

-- Transaction-scoped restore assertion; rows are inserted and removed in the same
-- restore batch. This is an empty coordination table, not backup application data.
CREATE TABLE hours_publication_restore_guard (
 installation_id TEXT PRIMARY KEY,
 generations_json TEXT NOT NULL CHECK(json_valid(generations_json))
);
CREATE TRIGGER hours_publication_restore_identity_guard BEFORE DELETE ON installations
WHEN EXISTS(SELECT 1 FROM hours_publication_restore_guard WHERE installation_id=OLD.id)
 AND EXISTS(
 SELECT 1 FROM hours_publication_generations g WHERE g.installation_id=OLD.id
 AND NOT (g.provider_event_id IS NULL AND EXISTS(SELECT 1 FROM hours_publication_operations o WHERE o.installation_id=g.installation_id AND o.activity_id=g.activity_id AND o.provider=g.provider AND o.generation=g.generation AND o.action='delete' AND o.status='complete'))
 AND NOT EXISTS(SELECT 1 FROM hours_publication_restore_guard r,json_each(r.generations_json) b WHERE r.installation_id=OLD.id
 AND json_extract(b.value,'$.activity_id')=g.activity_id
 AND json_extract(b.value,'$.provider')=g.provider
 AND json_extract(b.value,'$.generation')=g.generation
 AND json_extract(b.value,'$.connection_generation')=g.connection_generation
 AND json_extract(b.value,'$.destination')=g.destination
 AND json_extract(b.value,'$.application_id')=g.application_id
 AND json_extract(b.value,'$.marker')=g.marker
 AND (g.provider_event_id IS NULL OR json_extract(b.value,'$.provider_event_id')=g.provider_event_id)))
BEGIN
 SELECT RAISE(ABORT,'hours_publication_restore_identity');
END;
