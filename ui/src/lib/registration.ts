/**
 * Registration is fail-closed in production. Existing single-user installs do
 * not need an internet-accessible account-creation endpoint; operators must
 * opt in explicitly for a controlled onboarding window.
 */
export function isRegistrationEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.REGISTRATION_ENABLED !== undefined) {
    return env.REGISTRATION_ENABLED === "true";
  }
  return env.NODE_ENV !== "production";
}
