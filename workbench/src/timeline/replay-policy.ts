/** Both replay entry points share strict outcome checking and explicit forensic mode. */
export function replayArguments(args: string[]) {
  const flags = args.filter((arg) => arg.startsWith("--"));
  if (
    flags.some(
      (flag) => !["--require-passed", "--verification-only"].includes(flag),
    ) ||
    flags.length > 1
  )
    throw new Error(
      "Choose at most one replay policy: --verification-only or --require-passed",
    );
  return {
    positional: args.filter((arg) => !arg.startsWith("--")),
    verificationOnly: flags.includes("--verification-only"),
    hasPolicy: flags.length !== 0,
  };
}

export function replayExitCode(
  report: { status: string; recordedOutcome: string },
  verificationOnly: boolean,
) {
  if (report.status !== "verified") return 1;
  return !verificationOnly && report.recordedOutcome !== "passed" ? 2 : 0;
}
