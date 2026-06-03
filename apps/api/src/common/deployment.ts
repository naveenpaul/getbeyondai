/**
 * Deployment mode — distinguishes a self-hosted install (the operator runs
 * getbeyond on their own infra) from getbeyond Cloud (we run it for them).
 *
 * This gates connectors whose vendor terms only permit a self-hosted, BYO-key
 * integration. Apollo is the first: its API Terms (§3 first prong) forbid
 * accessing the API "via a third party's credentials", so Cloud servers calling
 * Apollo with a user's key is barred — but a self-hoster calling Apollo with
 * their OWN key on their OWN server is ordinary internal use. So Apollo
 * discovery is `self_host`-only; Cloud must use an open provider.
 *
 * Default is `self_host` — the safe default for the open-source distribution.
 * getbeyond Cloud sets `DEPLOYMENT_MODE=cloud` explicitly.
 */
export type DeploymentMode = 'self_host' | 'cloud';

/** DI token so providers/controllers can inject the mode (and tests override it). */
export const DEPLOYMENT_MODE = Symbol('DEPLOYMENT_MODE');

/** Read the deployment mode from the environment. Anything but `cloud` is `self_host`. */
export function resolveDeploymentMode(): DeploymentMode {
  return process.env.DEPLOYMENT_MODE === 'cloud' ? 'cloud' : 'self_host';
}

/** True when BYO-key Apollo may run (self-hosted installs only). */
export function isApolloAllowed(mode: DeploymentMode): boolean {
  return mode === 'self_host';
}
