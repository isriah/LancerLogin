import { readFile } from "node:fs/promises";

const workflow = await readFile(".github/workflows/provision-template.yml", "utf8");
const forbidden = ["workers.dev/", "account_id =", "database_id =", "api_token", "FRC", "RoboLancers"];
for (const value of forbidden) {
  if (workflow.includes(value)) throw new Error(`Template configuration contains forbidden deployment value: ${value}`);
}
console.log("Template deployment configuration is sanitized and mock-only.");
