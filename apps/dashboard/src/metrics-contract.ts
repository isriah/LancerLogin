export const metricKinds=['person-hours','participants','interactions','reach','outcomes','other'] as const;
export type MetricFields={title:string;kind:string;value:string;unit:string;periodStart:string;periodEnd:string;source:string;method:string;basis:string};
export type Metric=MetricFields&{id:string;revision:number;archived:boolean;createdAt:string;updatedAt:string};
export type ContextKind='activities'|'initiatives';
export type MetricContext={activityId?:string;initiativeId?:string;title:string;revision:number;eligible:boolean};
export type MetricDetail={metric:Metric;activities:MetricContext[];initiatives:MetricContext[];readOnly:boolean};
export type Selection={id:string;type:ContextKind;title:string;revision:number;eligible:boolean};
export const emptyMetric:MetricFields={title:'',kind:'other',value:'',unit:'',periodStart:'',periodEnd:'',source:'',method:'',basis:'measured'};
export const metricFields=(metric:MetricFields):MetricFields=>Object.fromEntries(Object.keys(emptyMetric).map(key=>[key,metric[key as keyof MetricFields]])) as MetricFields;
export function validDecimal(value:unknown):value is string{return typeof value==='string'&&/^-?(?:0|[1-9]\d{0,14})(?:\.\d{1,6})?$/.test(value)&&! /^-0(?:\.0+)?$/.test(value);}
function date(value:string){if(!/^\d{4}-\d{2}-\d{2}$/.test(value)||value<'1900-01-01'||value>'9999-12-31')return false;const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;}
export function metricErrors(value:MetricFields):Partial<Record<keyof MetricFields,string>>{
 const errors:Partial<Record<keyof MetricFields,string>>={};for(const [key,max] of [['title',200],['unit',80],['source',2000],['method',4000]] as const){const text=value[key];if(typeof text!=='string'||!text.trim()||text.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text))errors[key]=`Enter plain text, between 1 and ${max} characters.`;}
 if(!validDecimal(value.value))errors.value='Enter a decimal with at most 15 integer and 6 fractional digits. No exponent, leading zeros, plus sign, spaces or negative zero.';
 if(!metricKinds.includes(value.kind as typeof metricKinds[number]))errors.kind='Choose a metric kind.';if(!['measured','estimated'].includes(value.basis))errors.basis='Choose measured or estimated.';
 for(const key of ['periodStart','periodEnd'] as const)if(typeof value[key]!=='string'||!date(value[key]))errors[key]='Enter a valid date from 1900-01-01 through 9999-12-31.';
 if(!errors.periodStart&&!errors.periodEnd&&value.periodEnd<value.periodStart)errors.periodEnd='End date must be on or after start date.';return errors;
}
export function selections(detail:MetricDetail):Selection[]{return (['activities','initiatives'] as const).flatMap(type=>detail[type].map(link=>({id:(type==='activities'?link.activityId:link.initiativeId)!,type,title:link.title,revision:link.revision,eligible:link.eligible})));}
export function checkedMetric(value:Metric):Metric{if(!value||typeof value.id!=='string'||!Number.isSafeInteger(value.revision)||value.revision<0||typeof value.archived!=='boolean'||Object.keys(metricErrors(value)).length)throw Error('Invalid metric');return value;}
export function checkedDetail(value:MetricDetail){checkedMetric(value?.metric);for(const type of ['activities','initiatives'] as const){if(!Array.isArray(value[type])||value[type].some(link=>typeof (type==='activities'?link.activityId:link.initiativeId)!=='string'||typeof link.title!=='string'||!Number.isSafeInteger(link.revision)||typeof link.eligible!=='boolean'))throw Error('Invalid associations');}if(value.activities.length+value.initiatives.length>100)throw Error('Invalid associations');return value;}
