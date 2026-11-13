import { spawn } from "node:child_process";

/** Use Herdr's session environment for its persistent server. Passing
 * `--session` before `server` is not equivalent on every supported platform. */
export function startDetachedHerdrServer(
  executable: string,
  session: string,
  workspace: string,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const child = spawn(executable, ["server"], {
    detached: true,
    stdio: "ignore",
    cwd: workspace,
    env: {
      ...environment,
      PWD: workspace,
      HERDR_SESSION: session,
      HERDR_STARTUP_CWD: workspace,
      HERDR_MACOS_SERVER_CONTEXT: "user",
    },
  });
  child.unref();
}
