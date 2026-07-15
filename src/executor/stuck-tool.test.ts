import { describe, expect, it, vi } from "vitest";
import { STUCK_TOOL, createStuckTool, type StuckReport } from "./stuck-tool";

const valid: StuckReport = {
  category: "no-green-build",
  reason: "12 edits in and the build still fails on the same type error; out of bounded budget.",
};

async function call(tool: ReturnType<typeof createStuckTool>, args: unknown) {
  return tool.handler(args as never, undefined);
}

describe("stuck tool — bounded self-stop (AC2)", () => {
  it("invokes the side effect with the validated report on a good call", async () => {
    const onStuck = vi.fn((_r: StuckReport) => {});
    const tool = createStuckTool(onStuck);

    const result = await call(tool, valid);

    expect(result.isError).toBeFalsy();
    expect(onStuck).toHaveBeenCalledTimes(1);
    expect(onStuck.mock.calls[0]![0]).toEqual(valid);
  });

  it("rejects an empty reason without running the side effect", async () => {
    const onStuck = vi.fn((_r: StuckReport) => {});
    const tool = createStuckTool(onStuck);

    const result = await call(tool, { ...valid, reason: "" });

    expect(result.isError).toBe(true);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it("rejects an unknown category", async () => {
    const onStuck = vi.fn((_r: StuckReport) => {});
    const tool = createStuckTool(onStuck);

    const result = await call(tool, { category: "bored", reason: "x" });

    expect(result.isError).toBe(true);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it.each(["fix-iterations", "no-green-build", "futility"] as const)(
    "accepts the self-stop category %s",
    async (category) => {
      const onStuck = vi.fn((_r: StuckReport) => {});
      const tool = createStuckTool(onStuck);
      const result = await call(tool, { category, reason: "exhausted my bounded budget" });
      expect(result.isError).toBeFalsy();
      expect(onStuck).toHaveBeenCalledTimes(1);
    },
  );

  it("does not allow wall-clock as a self-stop category (daemon-imposed only)", async () => {
    const onStuck = vi.fn((_r: StuckReport) => {});
    const tool = createStuckTool(onStuck);
    const result = await call(tool, { category: "wall-clock", reason: "x" });
    expect(result.isError).toBe(true);
    expect(onStuck).not.toHaveBeenCalled();
  });

  it("exposes its fully-qualified tool name under the ralph server", () => {
    expect(STUCK_TOOL).toBe("mcp__ralph__stuck");
  });
});
