import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { readFileSync } from 'node:fs';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { resolveCivilTime, selectCivilTime, instantToCivil, addCalendarDays, elapsedIntegerMinutes } from '../packages/shared/src/civil-time.ts';

const input = (date, time, timeZone = 'America/New_York') => ({date, time, timeZone});
const cases = [
  [input('2026-03-08','02:30'), []],
  [input('2026-11-01','01:30'), ['2026-11-01T05:30:00.000Z','2026-11-01T06:30:00.000Z']],
  [input('2026-10-04','02:15','Australia/Lord_Howe'), []],
  [input('2026-04-05','01:45','Australia/Lord_Howe'), ['2026-04-04T14:45:00.000Z','2026-04-04T15:15:00.000Z']],
  [input('2011-12-30','12:00','Pacific/Apia'), []],
  [input('2011-12-31','00:00','Pacific/Apia'), ['2011-12-30T10:00:00.000Z']],
  [input('1969-09-30','12:00','Pacific/Kwajalein'), ['1969-09-30T01:00:00.000Z','1969-10-01T00:00:00.000Z']],
  [input('1972-01-07','00:30','Africa/Monrovia'), []],
  [input('2026-09-09','12:00','Asia/Kathmandu'), ['2026-09-09T06:15:00.000Z']],
  [input('2026-09-09','12:34:56.789','UTC'), ['2026-09-09T12:34:56.789Z']],
  [input('0000-01-01','00:00','UTC'), ['0000-01-01T00:00:00.000Z']],
  [input('0099-12-31','23:59','UTC'), ['0099-12-31T23:59:00.000Z']],
  [input('9999-12-31','23:59','UTC'), ['9999-12-31T23:59:00.000Z']],
];
const iso = candidates => candidates.map(c => new Date(c.epochMilliseconds).toISOString());
const fails = (fn, code) => assert.throws(fn, error => error.code === code);

test('civil resolver enumerates exact ordinary, skipped and repeated instants, including historical offsets', () => {
  for (const [value, expected] of cases) assert.deepEqual(iso(resolveCivilTime(value)), expected, JSON.stringify(value));
  assert.deepEqual(resolveCivilTime(input('2026-11-01','01:30')).map(c=>c.offsetSeconds),[-14400,-18000]);
  assert.equal(resolveCivilTime(input('1972-01-06','23:30','Africa/Monrovia'))[0].offsetSeconds,-2670);
  assert.equal(iso(resolveCivilTime(input('2026-09-09','12:34:56.7','UTC')))[0],'2026-09-09T12:34:56.700Z');
});
test('selection rejects gaps and implicit folds but permits explicit ordinary occurrence selection', () => {
  const folded=input('2026-11-01','01:30');
  fails(()=>selectCivilTime(folded),'ambiguous_time');
  assert.equal(selectCivilTime(folded,'later').epochMilliseconds-selectCivilTime(folded,'earlier').epochMilliseconds,3600000);
  fails(()=>selectCivilTime(input('2026-03-08','02:30'),'later'),'nonexistent_time');
  const ordinary=input('2026-09-09','12:00');
  assert.deepEqual(selectCivilTime(ordinary,'earlier'),selectCivilTime(ordinary,'later'));
  fails(()=>selectCivilTime(ordinary,'first'),'invalid_occurrence');
});
test('instant formatting retains padded civil dates, historical eras, precision and offset', () => {
  for(const [value] of cases) for(const candidate of resolveCivilTime(value)) {
    const formatted=instantToCivil(candidate.epochMilliseconds,value.timeZone);
    assert.equal(formatted.date,value.date);
    assert.equal(formatted.offsetSeconds,candidate.offsetSeconds);
    assert.equal(formatted.time,value.time.length===5?value.time+':00.000':value.time);
  }
  fails(()=>instantToCivil(NaN,'UTC'),'invalid_instant');
  fails(()=>instantToCivil(Date.parse('-000001-01-01T00:00Z'),'UTC'),'invalid_date');
  fails(()=>instantToCivil(Date.parse('+010000-01-01T00:00Z'),'UTC'),'invalid_date');
  fails(()=>instantToCivil(8640000000000000,'Pacific/Kiritimati'),'invalid_date');
});
test('validation and calendar arithmetic never normalize malformed dates, clocks, or range overflow', () => {
  for(const date of ['2026-02-29','2026-13-01','2026-04-31','26-01-01','2026-01-01Z']) fails(()=>resolveCivilTime(input(date,'12:00')),'invalid_date');
  for(const time of ['24:00','12:60','12:00:60','12:00Z','1:00','12:00:00.1234','12:00.5']) fails(()=>resolveCivilTime(input('2026-01-01',time)),'invalid_time');
  fails(()=>resolveCivilTime(input('2026-01-01','12:00','Invalid/Zone')),'invalid_timezone');
  assert.equal(addCalendarDays('2024-02-28',1),'2024-02-29');
  assert.equal(addCalendarDays('2024-02-29',1),'2024-03-01');
  assert.equal(addCalendarDays('0099-12-31',1),'0100-01-01');
  assert.equal(addCalendarDays('0000-03-01',-1),'0000-02-29');
  for(const [date,days] of [['0000-01-01',-1],['9999-12-31',1],['2026-01-01',0.5],['2026-01-01',Number.MAX_SAFE_INTEGER]]) fails(()=>addCalendarDays(date,days),'invalid_date');
});
test('exact duration distinguishes DST elapsed time, next date, zone changes, zero and fractional minutes', () => {
  const instant=(date,time,zone)=>selectCivilTime(input(date,time,zone)).epochMilliseconds;
  assert.equal(elapsedIntegerMinutes(instant('2026-03-08','01:30'),instant('2026-03-08','03:30')),60);
  assert.equal(elapsedIntegerMinutes(instant('2026-11-01','00:30'),instant('2026-11-01','02:30')),180);
  assert.equal(elapsedIntegerMinutes(instant('2026-09-09','23:30'),instant(addCalendarDays('2026-09-09',1),'00:30')),60);
  assert.equal(elapsedIntegerMinutes(instant('2026-03-08','00:00'),instant(addCalendarDays('2026-03-08',1),'00:00')),1380);
  assert.equal(elapsedIntegerMinutes(instant('2026-11-01','00:00'),instant(addCalendarDays('2026-11-01',1),'00:00')),1500);
  fails(()=>selectCivilTime(input(addCalendarDays('2011-12-29',1),'00:00','Pacific/Apia')),'nonexistent_time');
  const saved=selectCivilTime(input('2026-09-09','12:00'));
  const other=selectCivilTime(input('2026-09-09','12:00','America/Los_Angeles'));
  assert.equal(other.epochMilliseconds-saved.epochMilliseconds,10800000);
  assert.equal(saved.epochMilliseconds,Date.parse('2026-09-09T16:00Z'));
  for(const end of [0,-60000]) fails(()=>elapsedIntegerMinutes(0,end),'non_positive_duration');
  fails(()=>elapsedIntegerMinutes(0,60001),'non_integral_duration');
  fails(()=>elapsedIntegerMinutes(NaN,60000),'invalid_instant');
  fails(()=>elapsedIntegerMinutes(0.5,60000),'invalid_instant');
  fails(()=>elapsedIntegerMinutes(instant('1972-01-06','23:30','Africa/Monrovia'),instant('1972-01-07','01:00','Africa/Monrovia')),'non_integral_duration');
  assert.equal(elapsedIntegerMinutes(123,60123),1);
});
test('formatter work and cache remain bounded across zones', () => {
  const original=Intl.DateTimeFormat.prototype.formatToParts; let count=0;
  Intl.DateTimeFormat.prototype.formatToParts=function(...args){count++;return original.apply(this,args);};
  try {
    for(const [value] of cases){count=0;resolveCivilTime(value);assert.ok(count>=3&&count<=4);}
  } finally { Intl.DateTimeFormat.prototype.formatToParts=original; }
  const Original=Intl.DateTimeFormat;let constructors=0;
  Intl.DateTimeFormat=class extends Original {constructor(...args){super(...args);constructors++;}};
  try {
    const zones=Intl.supportedValuesOf('timeZone').slice(0,20);
    for(const zone of zones) resolveCivilTime(input('2026-09-09','12:00',zone));
    const afterFill=constructors;
    for(const zone of zones.slice(-16)) resolveCivilTime(input('2026-09-09','12:00',zone));
    assert.equal(constructors,afterFill);
    resolveCivilTime(input('2026-09-09','12:00',zones[0]));assert.equal(constructors,afterFill+1);
    resolveCivilTime(input('2026-09-09','12:00',zones[4]));assert.equal(constructors,afterFill+2);
  } finally {Intl.DateTimeFormat=Original;}
});
test('bundled shared implementation runs the same edge cases in local workerd',{timeout:30000},async()=>{
  const bundled=await transform(`${readFileSync(new URL('../packages/shared/src/civil-time.ts',import.meta.url),'utf8')}
export default {fetch(){return Response.json({candidates:${JSON.stringify(cases.map(c=>c[0]))}.map(resolveCivilTime),ancient:instantToCivil(Date.parse('0000-01-01T00:00Z'),'UTC'),next:addCalendarDays('2024-02-28',1),minutes:elapsedIntegerMinutes(selectCivilTime({date:'2026-03-08',time:'01:30',timeZone:'America/New_York'}).epochMilliseconds,selectCivilTime({date:'2026-03-08',time:'03:30',timeZone:'America/New_York'}).epochMilliseconds)});}};`,{loader:'ts',format:'esm'});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,compatibilityDate:'2026-08-01',script:bundled.code}));
  try{const result=await(await mf.dispatchFetch('http://localhost/')).json();assert.deepEqual(result.candidates.map(iso),cases.map(c=>c[1]));assert.deepEqual(result.ancient,{date:'0000-01-01',time:'00:00:00.000',offsetSeconds:0});assert.equal(result.next,'2024-02-29');assert.equal(result.minutes,60);}finally{await mf.dispose();}
});
