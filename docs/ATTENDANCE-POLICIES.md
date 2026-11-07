# Member labels and attendance policies

Administrators create, rename, retire, and restore labels in **Settings > Modules > Attendance > Labels**, and define requirements in **Settings > Modules > Attendance > Attendance rules**. The Labels page lists each label's current members (linking to a filtered Roster), attendance policy, meeting audiences, and Discord role. Admin and Operator dashboard access roles are separate from member labels. Members can hold several descriptive labels, including several labels with attendance policies. Every active policy is evaluated independently. Operators can view assignments and attendance; only Administrators can change labels or policies.

## Glossary

The dashboard, reports, CSV exports, email and Discord use these terms. The info buttons beside the Overall rate and policy result report columns, and beside the member-profile tiles, show the same definitions.

| Term | Meaning |
| --- | --- |
| **Overall rate** | Share of all required meetings attended. Excused meetings count as missed. The same for everyone. Earlier releases called it Regular attendance. |
| **Attendance policy** | A label's attendance target: a weighted percentage or a number of meetings each week, with its own handling of excused meetings. A label has at most one policy in effect on any date. |
| **Attendance rate** (policy result) | The rate this label's attendance policy uses. Depending on the policy, excused meetings may be left out. |
| **Last N days** | Measured over the last N days, ending today, regardless of the report's dates. N is the **Current-standing window (days)** setting. Weekly-count policies show the current week. Earlier releases called these columns Official policy. |
| **Policy result**, **Policy status**, **Policy target**, **Policy period** | The same policy measured over the report's own dates. Earlier releases called these Report-period policy columns. |
| **Met** | The member meets the policy's target. |
| **Below target** | The member is below the policy's target. |
| **In progress** | The current week is not finished yet. |
| **Not enough meetings yet** | No eligible meeting has happened in the window, so there is no result yet. |
| **No policy** | The label has no policy in effect for the dates shown, or the member does not hold the label. |
| **Weeks below target** | On a member profile, the weeks in which a weekly-count policy was not met. |

## Configure labels and policies

Create labels first. A label may have no attendance policy, one standing policy, and dated override periods. Override periods on the same label cannot overlap. Each policy uses one of two methods:

- **Weighted percentage** sets a threshold from greater than 0% through 100%. Completed, required meetings count when the member is in the meeting audience. Each meeting uses its saved attendance weight. Optional meetings stay out of the rate. Choose whether excused meetings are left out of the attendance rate or count as missed. Existing and new policies default to leaving them out. The system compares the unrounded rate with the threshold, then rounds the displayed rate. There is no status when no eligible opportunity exists.
- **Meetings per week** sets a whole-number target. Each completed meeting in the member's audience counts once, including optional meetings and meetings reached through any label the member holds. Meeting weight does not affect this count. The requirement cannot exceed available opportunities. Excused opportunities reduce the requirement. Extra attendance does not carry into another week. An unsettled current week is **In progress**; weeks with no due opportunities show **Not enough meetings yet**. A dated policy change within a Monday-to-Sunday week creates two separately evaluated partial weeks.

The organization-wide **Current-standing window (days)** starts at 30 calendar days and can be changed in Settings > Modules > Attendance > Attendance rules. It sets N for the **Last N days** policy columns, the Leaderboard's **Below target** panel and Discord reports. Weekly-count policies use the current week. Report columns without the Last N days prefix use the report's own dates. Existing meeting-weight controls are on the same Settings page.

## Configure a Class policy

Class attendance is an ordinary configurable policy rather than a percentage calculated for every member. An Administrator creates a **Class** member label, adds a **Weighted percentage** attendance requirement for it, leaves **Excused meetings in this policy** set to **Leave out of the attendance rate**, and assigns the label to the appropriate members. The threshold, effective dates, and label name remain installation choices. LancerLogin does not create or assign a Class label automatically.

A member may hold Class together with a team or program label that has its own attendance policy. For example, a member may have an 80% team policy that counts excuses as missed and a Class policy that excludes excuses. The dashboard, reports, alerts, CSV exports, email, and Discord reports show and evaluate both results independently. Adding or removing one policy label does not replace another policy label.

Every member still has an **Overall rate** for the selected reporting period. The Overall rate divides weighted present attendance by all completed, required meeting weight for which the member was in the audience and had started participation. Excused meetings remain in that denominator, so they count as missed. Optional, out-of-audience, pre-participation, future, and test meetings remain outside it. A policy assignment does not change the Overall rate, though label membership may change which audience-specific meetings are eligible.

For example, across five equal-weight required meetings, three present, one absent, and one excused produce a 60% Overall rate. A Class policy that leaves the excuse out produces a 75% attendance rate. Changing that policy to count excuses as missed produces 60%, while the Overall rate remains 60%.

Before applying or removing a policy, review the impact preview. A changed roster, meeting, attendance record, assignment, or policy invalidates the preview and requires another review. Policy edits and label changes leave audit entries.

## Assign labels

Open a member in **Roster** and choose a label, add or remove, and an optional effective date. Preview the change before applying it. The roster **Edit** dialog also shows current labels and a quick checklist for adding or removing labels, with the same optional effective date. The roster **Bulk edit** sidebar lets an Admin tick visible members, then preview and apply label additions, label removals, deactivation, or reactivation. Wherever you assign labels, a blank effective date uses today in the organization's configured time zone. Previews name each member as **First Last (member ID)** when the name is known. These actions do not sync Discord roles automatically.

To change many assignments from a file, choose **Import > Labels from CSV** in **Roster** and upload a separate CSV. **Download template** saves `label-changes-template.csv` with the header and one sample row. The required header columns are **memberId,label**. Optional **action** defaults to **add** and optional **effectiveDate** defaults to today in the organization's configured time zone. Header matching ignores case, spaces, underscores, hyphens, and dots, and also accepts **id** or **Student ID** for the member ID, **Label name** for the label, and **Effective date**, **Effective**, or **Date** for the date. Blank action and date cells use the same defaults. Explicit actions are **add** or **remove**; explicit dates use **YYYY-MM-DD**. The preview shows resolved actions and dates, every resulting current policy, and historical attendance impact. The roster CSV importer and label CSV importer are separate.

Meetings may have an audience of **All members** or any selected labels. A member holding any selected label is in that audience. A person may still scan at another meeting, but that scan does not create attendance credit toward their requirement.

## Read compliance

Roster, Dashboard, member profiles, Reports, filtered CSV, and existing on-demand email and Discord reports use the same Worker calculation. They distinguish the Overall rate from every assigned policy result and state each applicable period. A profile shows current compliance and all-time history for its current policy labels, starting no earlier than the member's attendance start date. Percentage periods summarize by weighted rate. Weekly periods summarize by weeks met divided by weeks due. Different policies and policy types remain separate.

### Attendance by label

A Members report can show one set of columns per label, with Overall rate once beside Member. Choose **Attendance by label** under **Start from a preset** on **New report**, or **Add column > Attendance policies (per label) > Attendance by label** in any Members report. Ticking a label adds its whole set and adds the label to the report's Labels filter; unticking removes the set. Single columns for one label stay under **Single policy column**. A report holds up to five sets.

| Column | Percentage policy | Meetings-per-week policy |
| --- | --- | --- |
| **Attendance rate** | Weighted meetings attended ÷ weighted meetings counted for the report's dates, to one decimal. | Weeks met ÷ weeks due. |
| **Target** | The required percentage, such as 80%. | Meetings each week, such as 2 per week. |
| **Status** | Met, Below target, Not enough meetings yet, or No policy. | The same, plus In progress while the current week isn't met yet. Any missed week is Below target. |
| **Meetings attended** | Plain meetings attended. | Plain meetings attended. |
| **Meetings counted** / **Weeks met** | Plain meetings counted: excused meetings are left out or included, as the policy says. | Weeks met. |
| **Excused** | Excused meetings. | Excused meetings. |

A heading above each set names the label and its policy in a few words. A **Weighted** tag marks a percentage policy whose required meetings include weights other than 1: the counts stay plain meetings, so the rate can differ from attended ÷ counted, and a note under the table says so. A member who doesn't hold the label shows **No policy** and empty cells. When a dated override and the standing policy both cover the report's dates, the set shows their meeting counts and **Multiple policies** instead of one rate. Filters, sorting and + Filter work on these columns like any other; + Filter reaches per-label fields that aren't in the table through **Attendance policies (per label)**, choosing the field and then the label.

On the **Leaderboard**, choosing one label in **Label group** ranks members by that label's Attendance rate, with a status pill beside each rate; **Sort** names the basis and still offers Overall rate. Members without the label are hidden, and the Below target panel is hidden in that view because the pills show it.

**How this is calculated.** The info buttons beside Overall rate and Attendance rate columns, and on the Leaderboard heading, give the definition, the label's policy in one line and a worked example with fixed sample numbers. A member profile's **How these rates are calculated** section explains that member's own rates step by step. In **Settings > Modules > Attendance > Attendance rules**, the policy form explains its rule as you edit it, including what the other excused-meeting choice would give, and each saved policy has a one-line example.

The report CSV writes rates as plain numbers with one decimal place (87.5, with the % in the header), targets and counts as whole numbers, and leaves cells empty when there is no value. Headers name their label, such as `Test Robotics Class - Attendance rate (%)`. A report with label sets also exports **Member ID** after **Member**. Overall rate exports as a plain number in every report, under the header `Overall rate (%)`.

The detailed attendance CSV uses explicit `regular*` (Overall rate) and `policy*` (attendance policy) summary columns alongside the underlying meeting records. The `policyResults` column contains the complete JSON list of current assigned policy results, while the scalar `policy*` fields remain for compatibility with existing imports. These machine headers keep their names even though the dashboard now says Overall rate. They replaced the older generic member-rate and excuse-adjusted summary headers. Update spreadsheet formulas or import mappings that relied on those older column names.

Removing a label or policy removes it from active configuration. Historical assignments, policy summaries, and audit records remain available wherever they are needed to explain past attendance.

Existing installations retain their label and attendance records through the additive migration. New installations start with no predefined labels or requirements. An Administrator can deliberately backdate a new policy or assignment after reviewing its impact. No automatic compliance email or Discord alert is created.
