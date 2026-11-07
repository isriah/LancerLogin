// The dashboard's CSV import kit: the shared parsers and formats, plus the browser download of a template file.
export { csvFieldFor, csvText, delimiterFor, formatCsvDate, formatCsvTime, formatCsvTimeRange, mapCsvHeader, normaliseCsvHeader, parseCsvDate, parseCsvDuration, parseCsvTime, parseDelimited } from "../../../packages/shared/src/csv-import.ts";
export type { CsvHeaderMapping, CsvHeaderSpec, CsvValue } from "../../../packages/shared/src/csv-import.ts";

/** Downloads `csv` as a UTF-8 file named `filename`. */
export function downloadCsvTemplate(filename: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" })); const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
