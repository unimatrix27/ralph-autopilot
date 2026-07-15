import { describe, expect, it } from "vitest";
import {
  LABEL_COMPLEXITY_1,
  LABEL_COMPLEXITY_2,
  LABEL_COMPLEXITY_3,
  LABEL_MODE_INFRA,
  LABEL_MODE_TDD,
  LABEL_MODE_UI,
  modeLabelFor,
  readMode,
  readTier,
  tierLabelFor,
} from "./labels";

describe("readMode", () => {
  it("reads each mode label", () => {
    expect(readMode([LABEL_MODE_TDD])).toBe("tdd");
    expect(readMode([LABEL_MODE_INFRA])).toBe("infra");
    expect(readMode([LABEL_MODE_UI])).toBe("ui");
  });

  it("returns null with no mode label", () => {
    expect(readMode(["ready-for-agent", "afk"])).toBeNull();
  });

  it("resolves duplicate mode labels by fixed vocabulary precedence (tdd → infra → ui), not label order", () => {
    expect(readMode([LABEL_MODE_UI, LABEL_MODE_TDD])).toBe("tdd");
    expect(readMode([LABEL_MODE_UI, LABEL_MODE_INFRA])).toBe("infra");
    expect(readMode([LABEL_MODE_INFRA, LABEL_MODE_TDD])).toBe("tdd");
  });
});

describe("modeLabelFor", () => {
  it("is the inverse of readMode for every mode", () => {
    for (const mode of ["tdd", "infra", "ui"] as const) {
      expect(readMode([modeLabelFor(mode)])).toBe(mode);
    }
  });
});

describe("readTier (issue #278)", () => {
  it("returns null for an unlabeled issue — the global profile, never a stall", () => {
    expect(readTier([])).toBeNull();
    expect(readTier(["ready-for-agent", "afk", "mode:tdd", "priority:p0"])).toBeNull();
  });

  it("reads each complexity label to its tier", () => {
    expect(readTier([LABEL_COMPLEXITY_1])).toBe(1);
    expect(readTier([LABEL_COMPLEXITY_2])).toBe(2);
    expect(readTier([LABEL_COMPLEXITY_3])).toBe(3);
  });

  it("reads the tier independent of label order and surrounding labels", () => {
    expect(readTier(["mode:tdd", LABEL_COMPLEXITY_2, "ready-for-agent"])).toBe(2);
  });

  it("resolves duplicate labels by vocabulary precedence — the most demanding tier wins", () => {
    // The readMode/pausedStateOf convention: scan order 1 → 2 → 3, never daemon-anomaly.
    expect(readTier([LABEL_COMPLEXITY_3, LABEL_COMPLEXITY_1])).toBe(1);
    expect(readTier([LABEL_COMPLEXITY_3, LABEL_COMPLEXITY_2])).toBe(2);
    expect(readTier([LABEL_COMPLEXITY_2, LABEL_COMPLEXITY_1, LABEL_COMPLEXITY_3])).toBe(1);
  });

  it("tierLabelFor is the inverse of readTier", () => {
    for (const tier of [1, 2, 3] as const) {
      expect(readTier([tierLabelFor(tier)])).toBe(tier);
    }
  });
});
