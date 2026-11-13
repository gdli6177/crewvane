import { createHash } from "node:crypto";
import { join } from "node:path";
import type { SessionBackendId } from "../../core/src/index.js";
import { HerdrAdapter } from "./herdr/adapter.js";
import { OrcaAdapter } from "./orca/adapter.js";
import type { BackendControlV1 } from "./control/types.js";
export function workspaceSessionName(root: string, environment = process.env) {
  return environment.CREWVANE_HERDR_SESSION?.trim() ||
    `crewvane-${createHash("sha256").update(root).digest("hex").slice(0, 10)}`;
}
export function localAdapter(input: {
  backend: SessionBackendId;
  workspace: string;
  control: BackendControlV1;
  directory: string;
  herdrExecutable?: string;
  environment?: NodeJS.ProcessEnv;
}) {
  const environment = input.environment ?? process.env;
  const directory = join(input.directory, "adapters", input.backend);
  const orcaHostHome = environment.CREWVANE_ORCA_HOST_HOME?.trim();
  const orcaEnvironment = input.backend === "orca" && orcaHostHome
    ? { ...environment, HOME: orcaHostHome }
    : environment;
  return input.backend === "orca" ? new OrcaAdapter({
    directory, appPath: input.control.orcaAppPath ?? "/Applications/Orca.app",
    environment: orcaEnvironment,
    // The profile is provided only by an explicit isolated test environment.
    ...(environment.CREWVANE_TEST_ZDOTDIR ? { shellEnvironment: { ZDOTDIR: environment.CREWVANE_TEST_ZDOTDIR } } : {}),
  }) : new HerdrAdapter({
    directory, executable: input.herdrExecutable ?? environment.CREWVANE_HERDR_BINARY ?? "herdr",
    session: workspaceSessionName(input.workspace, environment), environment,
    ...(environment.CREWVANE_TEST_ZDOTDIR ? { shellEnvironment: { ZDOTDIR: environment.CREWVANE_TEST_ZDOTDIR } } : {}),
  });
}
