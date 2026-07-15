/**
 * What the daemon hands a container at dispatch (ADR-0038, issue #184, epic #182). The
 * runner reads its {@link Assignment} + {@link RunToken} from dispatch and **never reads
 * GitHub to learn *what* to do** (epic user stories 15/34) — everything it needs to begin
 * is pushed in. This is the daemon→runner half of the boundary split; the runner's *work
 * product* (clone/push/PR/escalate) lands directly on GitHub, independent of the pipe.
 */
import type { Account, EffortLevel, ProviderName } from "../config/schema";
import type { Mode } from "../store/types";

/**
 * The per-run session-budget overrides the daemon resolved from the issue's complexity tier
 * (issue #278) — the tier's `effort` / `wallClockSeconds` deltas over the mounted config's
 * `agent.*` globals. Resolved DAEMON-side (the runner applies, never re-derives: it has no
 * tier logic and no label read), and **additive** on the dispatch payload: an old runner
 * simply ignores it (the runner's dispatch parse is presence-checked, not strict), running
 * on the globals as before. Impl-only — review/fix dispatches never carry one.
 */
export interface SessionProfile {
  /** Per-run reasoning effort (absent → the mounted config's `agent.effort`). */
  effort?: EffortLevel;
  /** Per-run wall-clock ceiling (absent → the mounted config's `agent.wallClockSeconds`). */
  wallClockSeconds?: number;
}

/**
 * One run's marching orders. Self-contained: the issue, the implementation `mode`, the WIP
 * `branch` to land work on, the `base` it targets, the built `prompt`, and — only on a
 * resume (DESIGN §6, resume-not-restart) — the operator's injected `answer`.
 */
export interface Assignment {
  /**
   * Which kind of run this is (ADR-0038 / issue #189). `impl` (the default when absent) is the
   * impl/resume path that opens a PR; `review` / `fix` are the review-loop's review and fix
   * passes, which run against the PR's existing head branch. The runner branches on this to host
   * the right session and report the matching terminal (`pr-opened` vs `reviewed`/`fixed`), and
   * the cloner uses it to clone the head branch directly (the code under review already lives
   * there) rather than forking a fresh WIP branch off base.
   */
  kind?: "impl" | "review" | "fix";
  /** The target issue this run implements. */
  issueNumber: number;
  /** The implementation path (`tdd` default, `infra`). */
  mode: Mode;
  /** The durable WIP git ref the run lands work on. */
  branch: string;
  /** The branch the eventual PR targets. */
  base: string;
  /** The fully-built agent prompt for this run. */
  prompt: string;
  /**
   * Set only for a rebase-conflict fix (`kind: "fix"`): a sibling PR merged into base mid-review
   * and the two touch the same code, so the fix agent must rebase the branch onto {@link base}
   * and the **runner** (not the agent session) force-pushes the resolved history. Under the
   * container model the agent runs in a fresh clone where no rebase is in progress, so the
   * cloner pre-fetches {@link base} into it and the runner owns the rebase force-push (force-push
   * is blocked in agent sessions, DESIGN §8) — the daemon then verifies it landed (#273). Named
   * for what it IS (a rebase-conflict fix), not "rebase in progress": none is, the agent starts one.
   */
  rebaseConflict?: boolean;
  /**
   * Present only when *resuming* a paused run: the operator's answer, re-injected so the
   * runner continues the WIP branch rather than restarting (DESIGN §6). Absent on a fresh run.
   */
  answer?: string;
  /**
   * The complexity tier's resolved session-budget overrides (issue #278), if the issue
   * carries a `complexity:*` label whose profile sets any. Absent → the mounted config's
   * `agent.*` globals apply, exactly as before.
   */
  profile?: SessionProfile;
}

/**
 * The per-run secret handed to the runner at dispatch. Opaque in this walking skeleton — it
 * exists to prove the dispatch path carries it end-to-end; later slices give it teeth
 * (scoping the runner's GitHub/LLM access for the lifetime of the run).
 */
export interface RunToken {
  /** The token value, treated as an opaque secret. */
  value: string;
}

/**
 * The concrete route one container runs on (ADR-0037): the `{ provider, model, account }`
 * the daemon resolved **pre-dispatch** via {@link import("../providers/resolve").resolveRoute}.
 * This is the success branch of a `RouteResolution` — a `{ wait: "no-provider" }` is never
 * dispatched (the run defers and re-resolves next tick). One container carries exactly one
 * route for its whole life — no mid-run rotation, no pool inside the container (ADR-0038).
 *
 * `model` is the route entry's per-type override; absent means "the provider's default model"
 * (the in-container backend resolves it from the provider-kind settings), so it is omitted
 * rather than guessed. `account` is the selected credential: the daemon mounts *its* cred dir
 * (claude `configDir` → `~/.claude`, codex `codexHome` → `~/.codex`) / forwards its token env
 * (z.ai `authTokenEnv`) for this run, and injects `provider`/`model` as env so the in-container
 * runner instantiates the matching {@link import("../providers/backend").SessionBackend}.
 */
export interface ContainerRoute {
  /** The provider kind backing this run (`claude` / `zai` / `openai`). */
  provider: ProviderName;
  /** The per-type model override, or absent for the provider's default model. */
  model?: string;
  /** The selected credential (the daemon mounts/forwards this account's auth for the run). */
  account: Account;
}

/**
 * Everything pushed into a container at `docker run` time: its orders, its token, and the
 * resolved {@link ContainerRoute}. The route makes dispatch **self-contained** (ADR-0037): the
 * daemon resolves it once, the {@link import("./docker-runner").DockerCliRunner} mounts the
 * selected account + injects `provider`/`model` from it, and #164 records it — no GitHub read,
 * no route resolution inside the container. Optional only so argv unit tests / a
 * routing-agnostic setup can omit it (then the box-default credentials are mounted).
 */
export interface ContainerDispatch {
  assignment: Assignment;
  token: RunToken;
  /** The resolved route this run executes on (ADR-0037); absent → box-default credentials. */
  route?: ContainerRoute;
}
