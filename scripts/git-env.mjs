// Git exports repository variables such as GIT_DIR and GIT_INDEX_FILE to hooks, and they override `git -C` and the
// working directory. A test or tool that creates or operates on its own repository while running inside a hook (the
// pre-push quick check, for example) would otherwise act on the hook's repository instead: one such test re-initialized
// a real checkout. Use isolatedGitEnv() for every git command that works on a temporary or plugin repository.

/** Variables that point git at a particular repository, index, object store or namespace, or limit discovery. */
export const gitRepositoryVariables = Object.freeze([
  "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES",
]);

const repositoryVariableNames = new Set(gitRepositoryVariables);

/** A copy of `env` without git's repository variables (matched case-insensitively, as Windows does). */
export function isolatedGitEnv(env = process.env, extra = {}) {
  const result = Object.fromEntries(Object.entries(env).filter(([name]) => !repositoryVariableNames.has(name.toUpperCase())));
  return { ...result, ...extra };
}

/** Remove git's repository variables from this process, for test files whose code under test spawns git itself. */
export function dropGitRepositoryVariables(env = process.env) {
  for (const name of Object.keys(env)) if (repositoryVariableNames.has(name.toUpperCase())) delete env[name];
}
