import { afterEach, describe, expect, it, vi } from "vitest";
import { WallClockExceededError } from "../executor/wall-clock";
import { CodexSessionBackend, type CodexClient, type CodexRunRequest } from "./codex-backend";

function backend(client: CodexClient, wallClockSeconds = 60): CodexSessionBackend {
  return new CodexSessionBackend({
    client,
    wallClockSeconds,
    model: "gpt-5.5",
    effort: "high",
    codexHome: "/home/box/.codex-ralph",
    baseUrl: "https://gw.example",
  });
}

/** A client that blocks until its turn signal aborts, then rejects with `aborted`. */
const hungClient: CodexClient = {
  run: (req: CodexRunRequest) =>
    new Promise<string>((_resolve, reject) => {
      req.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }),
};

describe("CodexSessionBackend", () => {
  afterEach(() => vi.useRealTimers());

  it("folds systemAppend into the prompt, forwards the session params, and returns finalResponse", async () => {
    let captured: CodexRunRequest | undefined;
    const client: CodexClient = {
      run: async (req) => {
        captured = req;
        return "FINAL RESPONSE";
      },
    };

    const result = await backend(client).run({
      prompt: "review the diff",
      worktreePath: "/wt/9",
      systemAppend: "REVIEW RUBRIC",
    });

    expect(result).toBe("FINAL RESPONSE");
    // The session-kind rubric is folded into the prompt (Codex has no system-append preset).
    expect(captured!.prompt).toBe("REVIEW RUBRIC\n\nreview the diff");
    expect(captured!.workingDirectory).toBe("/wt/9");
    expect(captured!.model).toBe("gpt-5.5");
    expect(captured!.effort).toBe("high");
    expect(captured!.codexHome).toBe("/home/box/.codex-ralph");
    expect(captured!.baseUrl).toBe("https://gw.example");
  });

  it("passes the prompt through unchanged when there is no systemAppend", async () => {
    let captured: CodexRunRequest | undefined;
    const client: CodexClient = {
      run: async (req) => {
        captured = req;
        return "ok";
      },
    };

    await backend(client).run({ prompt: "bare prompt", worktreePath: "/wt/1" });

    expect(captured!.prompt).toBe("bare prompt");
  });

  it("throws WallClockExceededError when the client hangs past the ceiling", async () => {
    vi.useFakeTimers();
    const promise = backend(hungClient, 1).run({ prompt: "p", worktreePath: "/wt" });
    const settled = promise.catch((e) => e);
    await vi.advanceTimersByTimeAsync(1000);

    expect(await settled).toBeInstanceOf(WallClockExceededError);
  });

  it("propagates a parent-signal abort as the client error, not a wall-clock kill", async () => {
    const controller = new AbortController();
    const promise = backend(hungClient, 60).run({
      prompt: "p",
      worktreePath: "/wt",
      abortSignal: controller.signal,
    });
    const settled = promise.catch((e) => e);
    controller.abort();
    const err = await settled;

    expect(err).not.toBeInstanceOf(WallClockExceededError);
    expect((err as Error).message).toBe("aborted");
  });
});
