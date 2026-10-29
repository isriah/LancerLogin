// GitHub Actions workflow commands for the installation and update scripts. Only fixed codes and fixed explanations
// are printed: provider bodies, subprocess output and error messages from other libraries may contain sensitive data.

const escapeData = (value) => String(value).replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (value) => escapeData(value).replaceAll(":", "%3A").replaceAll(",", "%2C");

export function errorAnnotation(code, message) { return `::error title=${escapeProperty(code)}::${escapeData(message)}`; }
export function warningAnnotation(code, message) { return `::warning title=${escapeProperty(code)}::${escapeData(message)}`; }

/** The thrown fixed code, or the fallback when the error is not one of this repository's codes. */
export function safeErrorCode(error, fallback) {
  const message = error instanceof Error ? error.message : undefined;
  return typeof message === "string" && /^[a-z][a-z0-9_]{2,80}$/.test(message) ? message : fallback;
}

/** Prints one error annotation that names the code and explains its cause and fix. */
export function reportFailure(error, help, fallback, fallbackMessage) {
  const code = safeErrorCode(error, fallback);
  console.log(errorAnnotation(code, help[code] ?? fallbackMessage));
  return code;
}
