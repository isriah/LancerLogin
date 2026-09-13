export const MIGRATION_SQL_LIMITS = Object.freeze({ bytes: 131072, statements: 36, statementBytes: 100000 });
const check = (value, code = 'migration-sql-unsupported') => { if (!value) throw Error(code); };

// Deliberately restricted SQLite migration lexer, not a general SQL validator.
// SQLite itself validates grammar inside the atomic batch. This lexer only finds
// trusted statement boundaries and rejects controls outside this transport's contract.
export function splitMigrationSql(input) {
  check(input instanceof Uint8Array && input.length > 0 && input.length <= MIGRATION_SQL_LIMITS.bytes, 'migration-sql-size');
  const sql = new TextDecoder('utf-8', { fatal: true }).decode(input);
  check(!sql.includes('\0'));
  const statements = []; let start = 0, tokens = [], trigger = false, body = false, cases = 0;
  function finish(end) {
    if (!tokens.length) { start = end; return; }
    const words = tokens.map(token => token.toUpperCase());
    check(!body && cases === 0);
    check(['CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'PRAGMA'].includes(words[0]));
    check(!words.some(word => word === 'D1_MIGRATIONS' || word.startsWith('_CF_') || word.startsWith('UPDATER_')));
    if (words[0] === 'PRAGMA') check(words.join(' ') === 'PRAGMA DEFER_FOREIGN_KEYS = ON');
    if (words[0] === 'CREATE') check(['TABLE', 'INDEX', 'TRIGGER'].includes(words[1]) || words[1] === 'UNIQUE' && words[2] === 'INDEX');
    const statement = sql.slice(start, end).trim();
    check(new TextEncoder().encode(statement).length <= MIGRATION_SQL_LIMITS.statementBytes, 'migration-sql-size');
    statements.push(statement); check(statements.length <= MIGRATION_SQL_LIMITS.statements, 'migration-statement-limit');
    start = end; tokens = []; trigger = false;
  }
  for (let i = 0; i < sql.length;) {
    const char = sql[i], next = sql[i + 1];
    if (/\s/.test(char)) { i++; continue; }
    if (char === '-' && next === '-') { const end = sql.indexOf('\n', i + 2); i = end < 0 ? sql.length : end + 1; continue; }
    if (char === '/' && next === '*') { const end = sql.indexOf('*/', i + 2); check(end >= 0); i = end + 2; continue; }
    if (["'", '"', '`', '['].includes(char)) {
      const closing = char === '[' ? ']' : char; let value = '', closed = false; i++;
      while (i < sql.length) { if (sql[i] === closing) { if (char !== '[' && sql[i + 1] === closing) { value += closing; i += 2; continue; } i++; closed = true; break; } value += sql[i++]; }
      check(closed); tokens.push(char === "'" ? '<string>' : value); continue;
    }
    if (/[A-Za-z_]/.test(char)) {
      const match = /^[A-Za-z_][A-Za-z_0-9$]*/.exec(sql.slice(i))[0], word = match.toUpperCase();
      tokens.push(word); i += match.length;
      if (tokens.length === 2 && tokens[0] === 'CREATE' && word === 'TRIGGER') trigger = true;
      if (trigger && word === 'BEGIN') { check(!body); body = true; }
      else if (body && word === 'CASE') cases++;
      else if (body && word === 'END') { if (cases) cases--; else body = false; }
      continue;
    }
    if (char === ';') { i++; if (!body) finish(i); continue; }
    tokens.push(char); i++;
  }
  finish(sql.length); check(statements.length > 0); return Object.freeze(statements);
}
