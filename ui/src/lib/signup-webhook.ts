/** Optional, best-effort notification. Never propagate delivery failures. */
export async function notifyCustomerSignup(email: string): Promise<void> {
  const url = process.env.SLACK_SIGNUP_WEBHOOK_URL;
  if (!url) return;

  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ app: "ftown", customer: email, email }),
      signal: AbortSignal.timeout(3000),
    });
    // Non-2xx responses are deliberately ignored; no retries.
  } catch {
    // Network errors and timeouts must not affect account creation.
  }
}
