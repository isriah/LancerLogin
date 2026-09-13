export const SNAPSHOT_LIMITS = Object.freeze({ rowBytes: 262144, pageRows: 64, pageRawBytes: 524288, pageBytes: 1100000, totalBytes: 16777216, pages: 512 });
const check = (value, code) => { if (!value) throw Error(code); };
export function rowId(value) {
  check(typeof value === 'string' && /^(0|-?[1-9][0-9]*)$/.test(value), 'snapshot-rowid');
  const integer = BigInt(value); check(integer >= -9223372036854775808n && integer <= 9223372036854775807n, 'snapshot-rowid'); return integer;
}
const quote = name => { check(typeof name === 'string' && /^[A-Za-z_][A-Za-z_0-9]*$/.test(name), 'snapshot-identifier'); return `"${name}"`; };
export function typedPageQuery(table, after) {
  const columns = table.columns.map(quote);
  check(columns.length > 0 && columns.length <= 100 && !table.columns.some(name => ['rowid', '_rowid_', 'oid', 'snapshot_rowid', 'snapshot_bytes', 'snapshot_cumulative', 'snapshot_ordinal'].includes(name.toLowerCase())), 'snapshot-columns');
  if (after !== null) rowId(after);
  const size = columns.map(column => `(CASE typeof(${column}) WHEN 'text' THEN length(CAST(${column} AS BLOB))+32 WHEN 'blob' THEN length(${column})+32 ELSE 32 END)`).join('+');
  const cells = columns.map(column => `CASE typeof(${column}) WHEN 'null' THEN json_array('null') WHEN 'integer' THEN json_array('integer',CAST(${column} AS TEXT)) WHEN 'real' THEN CASE WHEN abs(${column})<=1.7976931348623157e308 AND CAST(printf('%!.26g',${column}) AS REAL)=${column} THEN json_array('real',printf('%!.26g',${column})) ELSE json_array('unsupported') END WHEN 'text' THEN json_array('text',hex(CAST(${column} AS BLOB))) WHEN 'blob' THEN json_array('blob',hex(${column})) ELSE json_array('unsupported') END`);
  // CASE is evaluated before hex/JSON materialization for an oversized raw row.
  return { sql: `WITH candidates AS (SELECT _rowid_ AS snapshot_rowid,${size} AS snapshot_bytes FROM ${quote(table.name)}${after === null ? '' : ' WHERE _rowid_>CAST(? AS INTEGER)'} ORDER BY _rowid_ LIMIT ${SNAPSHOT_LIMITS.pageRows}), budgeted AS (SELECT *,sum(snapshot_bytes) OVER (ORDER BY snapshot_rowid) AS snapshot_cumulative,row_number() OVER (ORDER BY snapshot_rowid) AS snapshot_ordinal FROM candidates) SELECT CAST(snapshot_rowid AS TEXT) AS rowId,CASE WHEN snapshot_bytes>${SNAPSHOT_LIMITS.rowBytes} THEN 'oversize' ELSE json_array(${cells.join(',')}) END AS cells FROM budgeted JOIN ${quote(table.name)} ON _rowid_=snapshot_rowid WHERE snapshot_cumulative<=${SNAPSHOT_LIMITS.pageRawBytes} OR snapshot_ordinal=1 ORDER BY snapshot_rowid`, params: after === null ? [] : [after] };
}
export function encodeTypedPage(table, rows, after) {
  check(Array.isArray(rows) && rows.length <= SNAPSHOT_LIMITS.pageRows, 'snapshot-page');
  let previous = after === null ? null : rowId(after);
  const result = rows.map(row => {
    const current = rowId(row.rowId); check(previous === null || current > previous, 'snapshot-order'); previous = current;
    check(typeof row.cells === 'string' && row.cells !== 'oversize', 'snapshot-row-size');
    const cells = JSON.parse(row.cells); check(Array.isArray(cells) && cells.length === table.columns.length, 'snapshot-cells');
    for (const cell of cells) {
      check(Array.isArray(cell), 'snapshot-cell'); const [type, value] = cell;
      if (type === 'null') check(cell.length === 1, 'snapshot-cell');
      else {
        check(cell.length === 2 && typeof value === 'string', 'snapshot-cell');
        if (type === 'integer') rowId(value);
        else if (type === 'real') check(/^-?\d+\.\d+(e[+-]?\d+)?$/i.test(value), 'snapshot-real');
        else check(['text', 'blob'].includes(type) && /^(?:[0-9A-F]{2})*$/.test(value), 'snapshot-cell');
      }
    }
    return [row.rowId, cells];
  });
  const bytes = new TextEncoder().encode(JSON.stringify({ table: table.name, columns: table.columns, rows: result }));
  check(bytes.length <= SNAPSHOT_LIMITS.pageBytes, 'snapshot-page-size'); return bytes;
}
