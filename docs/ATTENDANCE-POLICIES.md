# Member labels and attendance policies

Administrators define labels and requirements in **Settings → Attendance**. Admin and Operator dashboard access roles are separate from member labels. Members can hold several descriptive labels, but at most one label with an attendance rule. Operators can view assignments and attendance; only Administrators can change labels or rules.

## Configure labels and rules

Create labels first. A label may have no attendance rule, one standing rule, and dated override periods. Override periods on the same label cannot overlap. Each rule uses one of two methods:

- **Weighted percentage** sets a threshold from greater than 0% through 100%. Completed, required meetings count when the member is in the meeting audience. Each meeting uses its saved attendance weight. Optional meetings stay out of the rate. Choose whether excused meetings leave the policy denominator or count as missed. Existing and new rules default to excluding them. The system compares the unrounded rate with the threshold, then rounds the displayed rate. There is no status when no eligible opportunity exists.
- **Meetings per week** sets a whole-number target. Each completed meeting in the member's audience counts once, including optional meetings and meetings reached through any label the member holds. Meeting weight does not affect this count. The requirement cannot exceed available opportunities. Excused opportunities reduce the requirement. Extra attendance does not carry into another week. An unsettled current week is pending; weeks with no due opportunities are not applicable. A dated rule change within a Monday-to-Sunday week creates two separately evaluated partial weeks.

The organization-wide recent window starts at 30 calendar days and can be changed in Settings → Attendance. It controls current percentage compliance. Weekly current compliance uses the current week. Existing meeting-weight controls are on the same Settings page.

## Configure a Class policy

Class attendance is an ordinary configurable policy rather than a percentage calculated for every member. An Administrator creates a **Class** member label, adds a **Weighted percentage** attendance requirement for it, leaves **Excused meetings** set to **Exclude from calculation**, and assigns the label to the appropriate members. The threshold, effective dates, and label name remain installation choices. LancerLogin does not create or assign a Class label automatically.

Every member still has **Regular attendance** for the selected reporting period. Regular attendance divides weighted present attendance by all completed, required meeting weight for which the member was in the audience and had started participation. Excused meetings remain in that denominator. Optional, out-of-audience, pre-participation, future, and test meetings remain outside it. A policy assignment does not change regular attendance, though label membership may change which audience-specific meetings are eligible.

For example, across five equal-weight required meetings, three present, one absent, and one excused produce 60% regular attendance. A Class policy that excludes the excuse produces 75%. Changing that policy to count excuses as missed produces 60%, while regular attendance remains 60%.

Before applying or removing a rule, review the impact preview. A changed roster, meeting, attendance record, assignment, or policy invalidates the preview and requires another review. Policy edits and label changes leave audit entries.

## Assign labels

Open a member in **Roster** and choose a label, add or remove, and an effective date. Preview the change before applying it. The roster **Edit** dialog also shows current labels and a quick checklist for adding or removing labels. Preview those changes before applying them. The roster **Bulk edit** control lets an Admin select visible members, then preview and apply label additions, label removals, deactivation, or reactivation. These actions do not sync Discord roles automatically.

To change many assignments from a file, use **Roster → Bulk label changes** and upload a separate CSV. The required header columns are **memberId,label**. Optional **action** defaults to **add** and optional **effectiveDate** defaults to today in the organization's configured time zone. Blank action and date cells use the same defaults. Explicit actions are **add** or **remove**; explicit dates use **YYYY-MM-DD**. The preview shows resolved actions and dates and validates each row, policy-label overlap, and historical attendance impact. The roster CSV importer and label CSV importer are separate.

Meetings may have an audience of **All members** or any selected labels. A member holding any selected label is in that audience. A person may still scan at another meeting, but that scan does not create attendance credit toward their requirement.

## Read compliance

Roster, Dashboard, member profiles, Reports, filtered CSV, and existing on-demand email and Discord reports use the same Worker calculation. They distinguish regular attendance from the assigned policy result and state the applicable period. A profile shows current compliance and all-time history for its current policy label, starting no earlier than the member's attendance start date. Percentage periods summarize by weighted rate. Weekly periods summarize by weeks met divided by weeks due. Different rule types are never blended into one historical score.

Attendance CSV exports use explicit `regular*` and `policy*` summary columns alongside the underlying meeting records. This replaces the older generic member-rate and excuse-adjusted summary headers. Update spreadsheet formulas or import mappings that relied on those older column names.

Existing installations retain their label and attendance records through the additive migration. New installations start with no predefined labels or requirements. An Administrator can deliberately backdate a new rule or assignment after reviewing its impact. No automatic compliance email or Discord alert is created.
