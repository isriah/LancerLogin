import test from "node:test";
import assert from "node:assert/strict";
import { calculateMemberStats,defaultRosterRates,loadReportAttendance,percent,type Meeting,type Row } from "../apps/dashboard/src/report-attendance.ts";

const meeting=(id: string,date: string,weight=1): Meeting => ({ id,title: id,startsAt: `${date}T10:00:00Z`,endsAt: `${date}T11:00:00Z`,required: true,attendanceWeight: weight });
const row=(disposition: Row["disposition"],memberId="one"): Row => ({ memberId,externalId: memberId,firstName: "Example",lastName: "Member",disposition });

test("primary rate includes excused weight and honors server not_required eligibility",() => {
  const meetings=[meeting("present","2020-01-01",0.5),meeting("excused","2020-01-02",1),meeting("pre-start","2020-01-03",4),meeting("absent","2020-01-04",2)];
  const rows={ present: [row("present")],excused: [row("excused")],"pre-start": [row("not_required")],absent: [row("absent")] };
  const [stat]=calculateMemberStats(meetings,rows);
  assert.equal(stat.primaryTotal,3.5); assert.equal(stat.adjustedTotal,2.5);
  assert.equal(percent(stat.present,stat.primaryTotal),14); assert.equal(percent(stat.present,stat.adjustedTotal),20);
  assert.equal(defaultRosterRates({ meetings,rows,baseline: "" }).rates.one.rate,14);
});

test("operational baseline is default and absent baseline preserves history",() => {
  const meetings=[meeting("old","2020-01-01",3),meeting("new","2020-02-01",1)];
  const rows={ old: [row("absent")],new: [row("present")] };
  assert.equal(defaultRosterRates({ meetings,rows,baseline: "2020-02-01" }).rates.one.rate,100);
  assert.equal(defaultRosterRates({ meetings,rows,baseline: "" }).rates.one.rate,25);
});

test("zero eligibility, measured zero, missing member data and no meetings stay distinct",() => {
  const meetings=[meeting("first","2020-01-01"),meeting("second","2020-01-02")];
  const result=defaultRosterRates({ meetings,baseline: "",rows: { first: [row("not_required"),row("absent","two"),row("present","missing")],second: [row("not_required"),row("absent","two")] } });
  assert.equal(result.rates.one.eligible,0); assert.equal(result.rates.one.complete,true);
  assert.equal(result.rates.two.eligible,2); assert.equal(result.rates.two.rate,0);
  assert.equal(result.rates.missing.complete,false); assert.equal(result.rates.unknown,undefined);
  assert.equal(defaultRosterRates({ meetings: [],rows: {},baseline: "" }).meetingCount,0);
});

test("loader excludes future and test meetings, retains optional completed history and requests inactive rows",async () => {
  const calls: string[]=[];
  const meetings=[meeting("done","2020-01-01"),{ ...meeting("optional","2020-01-02"),required: false },meeting("future","2099-01-01"),{ ...meeting("test","2020-01-01"),isTest: true }];
  const request=async <T>(path: string): Promise<T> => { calls.push(path); return (path==="/meetings"? { meetings,attendanceReportingStartsOn: "2020-01-01" }:{ attendance: [row("present")] }) as T; };
  const result=await loadReportAttendance(request);
  assert.deepEqual(result.meetings.map((value) => value.id),["done","optional"]);
  assert.deepEqual(calls,["/meetings","/attendance?meetingId=done&includeInactive=1","/attendance?meetingId=optional&includeInactive=1"]);
  assert.equal(result.baseline,"2020-01-01");
  await assert.rejects(loadReportAttendance(async <T>(path: string): Promise<T> => { if(path!=="/meetings") throw new Error("Failed"); return { meetings } as T; }),/Failed/);
});
