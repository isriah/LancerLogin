-- Replace only the non-key role column. Never drop the users parent table.
ALTER TABLE users ADD COLUMN role_next TEXT NOT NULL DEFAULT 'staff' CHECK (role_next IN ('admin', 'operator', 'staff'));
UPDATE users SET role_next = role;
ALTER TABLE users DROP COLUMN role;
ALTER TABLE users RENAME COLUMN role_next TO role;
