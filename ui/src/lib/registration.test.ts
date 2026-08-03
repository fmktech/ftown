import { describe, expect, it } from "vitest";

import { isRegistrationEnabled } from "./registration";

describe("isRegistrationEnabled", () => {
  it("fails closed in production when no override exists", () => {
    expect(isRegistrationEnabled({ NODE_ENV: "production" })).toBe(false);
  });

  it("allows an explicit production onboarding window", () => {
    expect(
      isRegistrationEnabled({
        NODE_ENV: "production",
        REGISTRATION_ENABLED: "true",
      }),
    ).toBe(true);
  });

  it("allows local development by default", () => {
    expect(isRegistrationEnabled({ NODE_ENV: "development" })).toBe(true);
  });

  it("honors an explicit opt-out outside production", () => {
    expect(
      isRegistrationEnabled({
        NODE_ENV: "development",
        REGISTRATION_ENABLED: "false",
      }),
    ).toBe(false);
  });
});
