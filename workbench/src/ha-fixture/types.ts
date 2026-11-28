export type NodeName = "node-a" | "node-b";
export type AccessMode = "openDemo" | "applicationPolicy";
export interface Images {
  postgres: string;
  jre: string;
  node: string;
  haproxy: string;
}
export interface FixtureOptions {
  mode: AccessMode;
  configuration: unknown;
  jar: string;
  /** Explicitly prepared Workbench dist directory. No fixture invokes a compiler. */
  dist: string;
  faultAgent?: string;
  images: Images;
  signal?: AbortSignal;
  directory?: string;
}
export interface Credentials {
  control: string;
  probe: string;
  operator: string;
  policy: string;
  database: string;
}
export type PolicyMode = "allow" | "deny" | "unavailable";
export interface SidecarSettings {
  name: NodeName;
  mode: AccessMode;
  controlToken: string;
  operatorToken: string;
  policyToken: string;
}
