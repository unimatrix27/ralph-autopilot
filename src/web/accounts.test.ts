import { describe, expect, it } from "vitest";
import type { Account } from "../config/schema";
import type { UsageState } from "../core/usage";
import { accountsResponseSchema } from "./contract";
import type { UsageMeterSnapshot } from "./health-usage";
import { buildAccounts, parseOauthIdentity, readAccountIdentity } from "./accounts";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const now = (): Date => NOW;

/** A claude usage state with headroom: both windows below the 85% gate, 5-hour resetting in an hour. */
function claudeState(): UsageState {
  return {
    windows: {
      seven_day: { utilization: 50, resetsAtMs: Date.parse("2026-07-20T00:00:00.000Z") },
      five_hour: { utilization: 40, resetsAtMs: Date.parse("2026-07-16T13:00:00.000Z") },
    },
    cooldownUntilMs: null,
  };
}

describe("buildAccounts — the pool panel join (issue #11)", () => {
  const pool: Account[] = [
    { id: "main", provider: "claude", configDir: "/home/op/.claude-main-SECRETDIR" },
    { id: "second", provider: "claude", configDir: "/home/op/.claude-second-SECRETDIR" },
    { id: "codex", provider: "openai", codexHome: "/home/op/.codex-SECRETHOME" },
    { id: "glm", provider: "zai", authTokenEnv: "ZAI_TOKEN_ENV_NAME" },
  ];
  const usage: UsageMeterSnapshot = {
    activeId: "main",
    ids: ["main", "second"],
    states: { main: claudeState() },
    disabledIds: ["second"],
  };
  const identities = {
    main: { emailAddress: "ada@example.com", displayName: "Ada Lovelace", organizationName: "Analytical Engines" },
  };

  it("emits a contract-valid payload for every resolved pool account", () => {
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    expect(accountsResponseSchema.safeParse(view).success).toBe(true);
    expect(view.generatedAt).toBe(NOW.toISOString());
    expect(view.admitBelowPercent).toBe(85);
    expect(view.accounts.map((a) => a.id)).toEqual(["main", "second", "codex", "glm"]);
  });

  it("carries identity for the account that has an OAuth profile and joins its usage windows by id", () => {
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    const main = view.accounts.find((a) => a.id === "main")!;
    expect(main.provider).toBe("claude");
    expect(main.enabled).toBe(true);
    expect(main.identity).toEqual({
      emailAddress: "ada@example.com",
      displayName: "Ada Lovelace",
      organizationName: "Analytical Engines",
    });
    // The active login binds new sessions; windows are type-ordered; reset instants are absolute ISO.
    expect(main.usage.active).toBe(true);
    expect(main.usage.gated).toBe(false);
    expect(main.usage.cooldownUntil).toBeNull();
    expect(main.usage.windows).toEqual([
      { type: "five_hour", utilization: 40, resetsAt: "2026-07-16T13:00:00.000Z" },
      { type: "seven_day", utilization: 50, resetsAt: "2026-07-20T00:00:00.000Z" },
    ]);
  });

  it("omits identity for an account whose configDir has no OAuth profile (graceful absence — regression)", () => {
    // `second` is a real pool account with no entry in `identities`: the field is omitted, never guessed.
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    const second = view.accounts.find((a) => a.id === "second")!;
    expect("identity" in second).toBe(false);
    expect(second.enabled).toBe(false); // operator-parked
    // Still contract-valid with the field absent.
    expect(accountsResponseSchema.safeParse(view).success).toBe(true);
  });

  it("renders a key-based account as id + provider, with at most the env-var NAME (never a value)", () => {
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    const glm = view.accounts.find((a) => a.id === "glm")!;
    expect(glm).toMatchObject({ id: "glm", provider: "zai", authTokenEnvName: "ZAI_TOKEN_ENV_NAME" });
    expect("identity" in glm).toBe(false);
    const codex = view.accounts.find((a) => a.id === "codex")!;
    expect(codex).toMatchObject({ id: "codex", provider: "openai" });
    expect("authTokenEnvName" in codex).toBe(false);
    expect("identity" in codex).toBe(false);
  });

  it("shows the null convention for a never-used / unmetered account", () => {
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    const codex = view.accounts.find((a) => a.id === "codex")!;
    expect(codex.usage).toEqual({ active: false, gated: false, cooldownUntil: null, windows: [] });
  });

  it("serializes NO secret material from the fixture pool (configDir / codexHome / token values)", () => {
    const view = buildAccounts({ pool, disabledAccounts: ["second"], usage, identities, admitBelowPercent: 85, now });
    const wire = JSON.stringify(view);
    expect(wire).not.toContain("SECRETDIR");
    expect(wire).not.toContain("SECRETHOME");
    expect(wire).not.toContain(".claude-main");
    expect(wire).not.toContain(".codex-");
    // The env-var NAME may be shown; the point is no credential *value* is ever present.
    expect(wire).toContain("ZAI_TOKEN_ENV_NAME");
  });

  it("marks a gated / cooled-down account from its usage state", () => {
    const cooled: UsageMeterSnapshot = {
      activeId: "main",
      ids: ["main"],
      states: {
        main: {
          windows: { five_hour: { utilization: 92, resetsAtMs: Date.parse("2026-07-16T15:00:00.000Z") } },
          cooldownUntilMs: Date.parse("2026-07-16T12:30:00.000Z"),
        },
      },
      disabledIds: [],
    };
    const view = buildAccounts({
      pool: [{ id: "main", provider: "claude", configDir: "/x" }],
      disabledAccounts: [],
      usage: cooled,
      identities: {},
      admitBelowPercent: 85,
      now,
    });
    const main = view.accounts[0]!;
    expect(main.usage.gated).toBe(true);
    expect(main.usage.cooldownUntil).toBe("2026-07-16T12:30:00.000Z");
  });
});

describe("parseOauthIdentity — the daemon-side OAuth profile fold", () => {
  it("extracts email / displayName / organizationName from a `.claude.json` oauthAccount", () => {
    expect(
      parseOauthIdentity({
        oauthAccount: {
          emailAddress: "ada@example.com",
          displayName: "Ada",
          organizationName: "AE",
          accountUuid: "ignored",
        },
      }),
    ).toEqual({ emailAddress: "ada@example.com", displayName: "Ada", organizationName: "AE" });
  });

  it("omits an absent field rather than guessing (a profile without displayName)", () => {
    expect(parseOauthIdentity({ oauthAccount: { emailAddress: "ada@example.com" } })).toEqual({
      emailAddress: "ada@example.com",
    });
  });

  it("returns undefined when there is no oauthAccount, or no usable field", () => {
    expect(parseOauthIdentity({})).toBeUndefined();
    expect(parseOauthIdentity({ oauthAccount: {} })).toBeUndefined();
    expect(parseOauthIdentity({ oauthAccount: { emailAddress: "" } })).toBeUndefined();
    expect(parseOauthIdentity(null)).toBeUndefined();
    expect(parseOauthIdentity("nope")).toBeUndefined();
  });
});

describe("readAccountIdentity — the injected disk read at projection time", () => {
  const claude: Account = { id: "main", provider: "claude", configDir: "/home/op/.claude-main" };

  it("reads <configDir>/.claude.json for a claude account", () => {
    const seen: string[] = [];
    const identity = readAccountIdentity(claude, (path) => {
      seen.push(path);
      return JSON.stringify({ oauthAccount: { emailAddress: "ada@example.com" } });
    });
    expect(identity).toEqual({ emailAddress: "ada@example.com" });
    expect(seen[0]).toContain(".claude.json");
  });

  it("returns undefined gracefully when the profile file is absent (a live case, not an error)", () => {
    const identity = readAccountIdentity(claude, () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });
    expect(identity).toBeUndefined();
  });

  it("returns undefined on malformed JSON rather than throwing", () => {
    expect(readAccountIdentity(claude, () => "{ not json")).toBeUndefined();
  });

  it("never reads for a key-based (openai/zai) account", () => {
    let reads = 0;
    const read = (): string => {
      reads += 1;
      return "{}";
    };
    expect(readAccountIdentity({ id: "glm", provider: "zai", authTokenEnv: "ZAI" }, read)).toBeUndefined();
    expect(readAccountIdentity({ id: "codex", provider: "openai", codexHome: "/x" }, read)).toBeUndefined();
    expect(reads).toBe(0);
  });
});
