import { spawn } from "node:child_process";

// Run independent commands at once. Each job's output is buffered and printed as one block when it
// finishes, so interleaved progress never hides which job a line or failure belongs to.
export function runJob({ label, command, args = [], cwd = process.cwd(), env = process.env }) {
  return new Promise((resolveJob) => {
    const started = Date.now();
    const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { output += chunk; });
    const finish = (status, extra = "") => resolveJob({ label, status, output: output + extra, seconds: (Date.now() - started) / 1000 });
    child.once("error", (error) => finish(1, `${error.message}\n`));
    child.once("close", (status, signal) => finish(status ?? 1, signal ? `Stopped by ${signal}.\n` : ""));
  });
}

export async function runJobs(title, jobs, { write = (text) => process.stdout.write(text) } = {}) {
  const started = Date.now();
  write(`${title}: running ${jobs.length} job(s) in parallel: ${jobs.map(({ label }) => label).join(", ")}\n`);
  const results = await Promise.all(jobs.map((job) => runJob(job).then((result) => {
    write(`\n=== ${result.label}: ${result.status === 0 ? "passed" : `FAILED (exit ${result.status})`} in ${result.seconds.toFixed(1)}s ===\n${result.output}`);
    return result;
  })));
  const failed = results.filter(({ status }) => status !== 0).map(({ label }) => label);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  write(failed.length ? `\n${title} failed in ${seconds}s: ${failed.join(", ")}.\n` : `\n${title} passed in ${seconds}s.\n`);
  return failed.length ? 1 : 0;
}
