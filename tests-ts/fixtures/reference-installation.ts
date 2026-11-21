// The reference team the Workers Free budget is sized for (private/plans/PRE-STABLE-FIXES.md, item 2): 150 members, 12
// labels, 3 kiosks, 300 meetings a season over three seasons, about 30 members scanning in and out of each meeting, with
// the corrections, Discord absence notices, contests, deliveries and audit history that go with them. About 74,000
// records and a 17 MB entire-installation backup. All data is synthetic.
//
// The rows are plain SQL so the same data seeds node:sqlite (TestD1Database) and local D1 (Miniflare). Each statement is
// one line, as D1's exec() requires. They go on top of an installation that already has the `admin` user.

export type ReferenceShape = {
  readonly members: number;
  readonly labels: number;
  readonly kiosks: number;
  readonly meetingsPerSeason: number;
  readonly seasons: number;
  /** Members who scan in and out of each meeting. */
  readonly attendeesPerMeeting: number;
  readonly correctionsPerMeeting: number;
  readonly noticeRecipientsPerMeeting: number;
  readonly auditEntries: number;
  readonly deliveries: number;
};

export const referenceShape: ReferenceShape = { members: 150, labels: 12, kiosks: 3, meetingsPerSeason: 300, seasons: 3, attendeesPerMeeting: 30, correctionsPerMeeting: 2, noticeRecipientsPerMeeting: 10, auditEntries: 4000, deliveries: 2000 };

const numbers = (name: string, count: number) => `${name}(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM ${name} WHERE x<${count})`;
const id = (prefix: string, expression: string) => `'${prefix}' || printf('%0${36 - prefix.length}d', ${expression})`;

/** How many records of each table the statements create. */
export function referenceCounts(shape: ReferenceShape = referenceShape) {
  const meetings = shape.meetingsPerSeason * shape.seasons;
  return {
    members: shape.members, member_labels: shape.labels, member_label_changes: shape.members * 2, pairing_codes: shape.kiosks, kiosks: shape.kiosks,
    meetings, meeting_audience_labels: Math.floor(meetings / 3), attendance_events: meetings * shape.attendeesPerMeeting * 2,
    attendance_corrections: meetings * shape.correctionsPerMeeting, discord_attendance_notifications: meetings,
    discord_attendance_recipients: meetings * shape.noticeRecipientsPerMeeting, discord_attendance_contests: Math.floor(meetings / 3),
    integration_deliveries: shape.deliveries, audit_log: shape.auditEntries,
  };
}

/** One-line SQL statements, parents before children. Members are numbered 1 to `members`; a meeting's attendees, excused members and notice recipients never overlap. */
export function referenceInstallationSql(shape: ReferenceShape = referenceShape): string[] {
  if (shape.attendeesPerMeeting * 5 > shape.members) throw new Error("The reference shape needs at least five members per attendee");
  const meetings = shape.meetingsPerSeason * shape.seasons;
  const member = (expression: string) => id("test-member-", `((${expression}) % ${shape.members}) + 1`);
  const meeting = (expression: string) => id("test-meeting-", expression);
  // Season one starts 2024-09-01; each season's meetings are a day apart, 18:00 to 20:00 UTC.
  const day = `date('2024-09-01', '+' || ((m.x - 1) / ${shape.meetingsPerSeason}) || ' years', '+' || ((m.x - 1) % ${shape.meetingsPerSeason}) || ' days')`;
  return [
    `WITH RECURSIVE ${numbers("m", shape.members)} INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id,active,created_at,attendance_required_from,inactive_periods_json) SELECT ${id("test-member-", "x")},'primary',printf('T%04d',x),'Test','Student ' || x,'test.student' || x || '@example.test',printf('9%017d',x),1,'2024-08-15T00:00:00.000Z','2024-09-01','[]' FROM m`,
    `WITH RECURSIVE ${numbers("m", shape.labels)} INSERT INTO member_labels(id,installation_id,name,active,formula_enabled,created_by,created_at) SELECT ${id("test-label-", "x")},'primary','Test Label ' || x,1,0,'admin','2024-08-15T00:00:00.000Z' FROM m`,
    `WITH RECURSIVE ${numbers("m", shape.members)} INSERT INTO member_label_changes(id,installation_id,member_id,label_id,action,effective_date,created_by,created_at,source) SELECT ${id("test-change-a-", "x")},'primary',${id("test-member-", "x")},${id("test-label-", `(x % ${shape.labels}) + 1`)},'add','2024-09-01','admin','2024-09-01T00:00:00.000Z','dashboard' FROM m UNION ALL SELECT ${id("test-change-b-", "x")},'primary',${id("test-member-", "x")},${id("test-label-", `((x * 7) % ${shape.labels}) + 1`)},'add','2024-09-02','admin','2024-09-02T00:00:00.000Z','dashboard' FROM m`,
    `WITH RECURSIVE ${numbers("m", shape.kiosks)} INSERT INTO pairing_codes(id,installation_id,code_hash,expires_at,redeemed_at,created_by,created_at,purpose,kiosk_kind,kiosk_name) SELECT ${id("test-pairing-", "x")},'primary','test-code-hash-' || x,'2024-08-16T00:00:00.000Z','2024-08-15T00:10:00.000Z','admin','2024-08-15T00:00:00.000Z','hardware','pi','Test Kiosk ' || x FROM m`,
    `WITH RECURSIVE ${numbers("m", shape.kiosks)} INSERT INTO kiosks(id,installation_id,pairing_code_id,name,token_hash,active,created_at,pairing_bound,authentication_method,configured_authentication_method) SELECT ${id("test-kiosk-", "x")},'primary',${id("test-pairing-", "x")},'Test Kiosk ' || x,'test-token-hash-' || x,1,'2024-08-15T00:10:00.000Z',1,'fingerprint','fingerprint' FROM m`,
    `WITH RECURSIVE ${numbers("m", meetings)} INSERT INTO meetings(id,installation_id,title,starts_at,ends_at,required,notes,created_by,created_at,audience_mode) SELECT ${meeting("m.x")},'primary','Test Meeting ' || m.x,${day} || 'T18:00:00.000Z',${day} || 'T20:00:00.000Z',1,NULL,'admin','2024-08-20T00:00:00.000Z',CASE WHEN m.x % 3 = 0 THEN 'labels' ELSE 'all' END FROM m`,
    `WITH RECURSIVE ${numbers("m", meetings)} INSERT INTO meeting_audience_labels(installation_id,meeting_id,label_id) SELECT 'primary',${meeting("m.x")},${id("test-label-", `(m.x % ${shape.labels}) + 1`)} FROM m WHERE m.x % 3 = 0`,
    ...["check_in", "check_out"].map((action, index) => `WITH RECURSIVE ${numbers("m", meetings)}, ${numbers("a", shape.attendeesPerMeeting)} INSERT INTO attendance_events(id,installation_id,member_id,meeting_id,source,occurred_at,kiosk_event_id,created_by,action) SELECT ${id(`test-event-${index}-`, "m.x * 1000 + a.x")},'primary',${member("m.x * 7 + a.x * 5")},${meeting("m.x")},'kiosk',${day} || 'T${index ? "20" : "18"}:' || printf('%02d', a.x) || ':00.000Z',${id(`test-scan-${index}-`, "m.x * 1000 + a.x")},NULL,'${action}' FROM m CROSS JOIN a`),
    `WITH RECURSIVE ${numbers("m", meetings)}, ${numbers("a", shape.correctionsPerMeeting)} INSERT INTO attendance_corrections(id,installation_id,member_id,meeting_id,disposition,reason,created_by,created_at) SELECT ${id("test-correction-", "m.x * 1000 + a.x")},'primary',${member("m.x * 7 + a.x * 5 + 1")},${meeting("m.x")},'excused','Synthetic excused absence','admin',${day} || 'T21:00:00.000Z' FROM m CROSS JOIN a`,
    `WITH RECURSIVE ${numbers("m", meetings)} INSERT INTO discord_attendance_notifications(installation_id,meeting_id,status,message_id,attempts,processed_at,updated_at,channel_id,expires_at,delivery_id) SELECT 'primary',${meeting("m.x")},'delivered',printf('8%017d',m.x),1,${day} || 'T20:30:00.000Z',${day} || 'T20:30:00.000Z','223456789012345678',${day} || 'T23:59:00.000Z',${id("test-batch-", "m.x")} FROM m`,
    `WITH RECURSIVE ${numbers("m", meetings)}, ${numbers("a", shape.noticeRecipientsPerMeeting)} INSERT INTO discord_attendance_recipients(installation_id,meeting_id,member_id,discord_user_id,message_id,delivered_at,delivery_id) SELECT 'primary',${meeting("m.x")},${member("m.x * 7 + a.x * 5 + 2")},printf('9%017d',((m.x * 7 + a.x * 5 + 2) % ${shape.members}) + 1),printf('8%017d',m.x),${day} || 'T20:30:00.000Z',${id("test-batch-", "m.x")} FROM m CROSS JOIN a`,
    `WITH RECURSIVE ${numbers("m", meetings)} INSERT INTO discord_attendance_contests(installation_id,meeting_id,member_id,message_id,status,resolved_by,resolved_at,created_at,submitted_by_discord_user_id,review_note,prior_reviews_json) SELECT 'primary',${meeting("m.x")},${member("m.x * 7 + 5 + 2")},printf('8%017d',m.x),'approved','admin',${day} || 'T22:00:00.000Z',${day} || 'T21:00:00.000Z',printf('9%017d',((m.x * 7 + 5 + 2) % ${shape.members}) + 1),NULL,'[]' FROM m WHERE m.x % 3 = 0`,
    `WITH RECURSIVE ${numbers("m", shape.deliveries)} INSERT INTO integration_deliveries(id,installation_id,provider,delivery_key,status,external_id,created_at,updated_at) SELECT ${id("test-delivery-", "x")},'primary','discord','test-delivery-key-' || x,'delivered',printf('7%017d',x),'2025-01-01T00:00:00.000Z','2025-01-01T00:00:01.000Z' FROM m`,
    `WITH RECURSIVE ${numbers("m", shape.auditEntries)} INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ${id("test-audit-", "x")},'primary','admin','meeting.updated','meeting',${meeting(`(x % ${meetings}) + 1`)},'{"fields":["title","startsAt","endsAt"],"synthetic":true}','2025-01-01T00:00:00.000Z' FROM m`,
  ];
}
