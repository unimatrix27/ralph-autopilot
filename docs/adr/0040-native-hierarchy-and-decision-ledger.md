# Native issue hierarchy as the only zoom-out authority, and a durable scoped decision ledger

## Context

Every agent ralph runs reasons from one issue and one run. That is the right frame
for a worker, and the wrong frame for the high-tier **master escalation** agent the
next slices need: one that can see where an issue sits in a programme, what has
already been decided above it, and why — without a human re-explaining it.

Two things were missing, and neither can be faked with conversational memory:

1. **Reproducible zoomed-out context.** The repo's tickets already carry GitHub's
   *native* parent/sub-issue relationships at arbitrary depth. Prose headings —
   "epic", "master epic", "wayfinder" — are how humans *narrate* that structure, not
   a contract: the word appears at whatever level the author felt like, and drifts
   as tickets are re-parented.
2. **Durable cross-run decisions.** A master session is fresh every time (ADR-0008).
   Anything it decides that a later session must honour has to live somewhere
   outside the session, in a form a later reader can fold deterministically.

This ADR covers the foundation only: hierarchy, context assembly, and the decision
ledger. Running a master agent is a later slice; `escalate`, `stuck`, review, and
merge behaviour are untouched.

## Decision

**1. GitHub's native parent/sub-issue graph is the only hierarchy authority.**
Nothing is inferred from titles, labels, links, or prose. The port reads the graph
through GraphQL (`Issue.parent`, `Issue.subIssues`) — the only surface that answers
"who is this issue's parent?" — and every node carries its own
`repository { nameWithOwner }`, so a cross-repository hierarchy is represented as it
is rather than flattened into the local repo.

**2. Depth is unbounded by product semantics; the ceiling is technical and loud.**
There is no "epic level". The climb stops at `HIERARCHY_DEPTH_CEILING` (32) as a
safety stop against a pathological graph, and hitting it is an explicit
`over-ceiling` result naming the ancestor it stopped before — never a silently
shortened path.

**3. Never a false root.** `RootResolution` has exactly one variant that means "this
is the absolute root", reached only when GitHub itself reports no parent. A cycle, an
over-ceiling chain, a deleted parent, and an unauthorized parent are each their own
typed value. This is the load-bearing decision: an unreadable parent collapsed into
"no parent" would plant an initiative-scoped decision — or the root index — on a node
that merely *looked* like the top. Callers that need the root go through
`absoluteRoot(map)` and fail closed when it is `null`, and the fold takes the proven
root **explicitly** rather than reading `path[0]` — after a failed climb that is just
the highest node reached, so a read that trusted it would fail open exactly where the
write path fails closed.

Three consequences of the same rule, each a place a plausible shortcut would
manufacture a root or a completeness claim:

- **A partial GraphQL response is not a clean one.** GitHub answers a masked parent
  with `parent: null` plus an error, and that error is not reliably pathed at
  `parent` (a `RATE_LIMITED` or `MAX_NODE_LIMIT_EXCEEDED` entry carries no path). A
  null parent alongside *any* error is `inaccessible` — otherwise a transient rate
  limit invents a root.
- **`deleted` means "gone, or invisible to this token".** GitHub deliberately
  answers `NOT_FOUND` for resources a token may not see, so the three reasons help a
  human adjudicate; they never gate behaviour, and all three are equally "not a root".
- **Sub-issue pages are prefixes.** The query asks for `totalCount`, so a node with
  more children than one page reports what was elided instead of a listing that reads
  as complete — and the subtree crawl says when it could not see them all.

**4. Context assembly is two-pass, budgeted, and deterministic.** Pass one builds a
compact relationship map from body-less native reads, so every sibling branch is
*visible* for one line's cost. Pass two fetches bodies and comments only for the
nodes it selects — origin, ancestors, direct children, plus explicit extras. The
budget is a plain **character** count (tokenizer-independent, so it means the same
thing across providers), selection order is fixed, and every child listing is sorted,
so the same hierarchy yields a byte-identical packet. When the budget binds, the
packet names the nodes it trimmed and the nodes it dropped — and "trimmed" covers any
cause, so a packet can never report `truncated: false` while the comment cap dropped
half a thread. Content degrades towards the **latest** state: both the per-node
comment cap and the budget fill keep the newest comments, because a session under
pressure needs the current answer, not the opening of the thread.

**5. Decisions live on the narrowest hierarchy node matching their scope.**
`issue` → the issue; `subtree` → the subtree root it governs; `initiative` → the
absolute root. A descendant loads the active ledger along its entire root→issue
ancestor path — so a sibling subtree's decisions are simply not on the path and are
never inherited, with no filtering rule to get wrong.

**6. Canonical records are append-only fenced GitHub comments.** One
`ralph-decision` payload through the shared fenced-payload codec, carrying the
decision, rationale, constraints, rejected alternatives, affected nodes/paths,
evidence, provenance (repo/issue/run/phase/head SHA), authoring model, timestamp, and
an optional `supersedes`. **Supersession is by id, never by recency** — comment
order and timestamps decide nothing — and the superseded comment is never edited.

**7. Conflicts and malformed records fail closed and stay visible.** Two active
records for one key with no supersession between them do not resolve to a winner:
the key drops out of `active` and both claims surface with their node and comment id
for a later master or human to adjudicate. A fenced-but-unparseable comment is a
diagnostic, not state. An ordinary comment that merely *discusses* a decision, or
pastes one inside a ` ```json ` block, is never parsed as one — extraction is
anchored on the fence tag, **exactly** (so `ralph-decision-index`, which the shorter
name prefixes, is not read back as a malformed record).

Failing closed only earns its keep if it fires on real disagreement, so two cases are
explicitly *not* conflicts:

- **A byte-identical re-post is one decision.** `appendDecision` does no
  read-before-write, so a `gh issue comment` that times out after GitHub committed it
  and is then retried leaves two identical comments. Collapsing them (with a
  diagnostic) keeps a retry from permanently fail-closing a decision nobody disputes;
  two *different* records under one id still conflict.
- **Same key, different node, in the whole-tree view is not disagreement.** In the
  per-issue fold every candidate binds the same issue, so the key alone is the
  bucket. The initiative fold spans unrelated branches, where two issues each
  recording their own `issue`-scoped `test-strategy` are doing their own business —
  there, records conflict only when they govern the *same* node. A false conflict in
  the index would bury the real ones; a genuine cross-node disagreement is still
  caught by the per-issue fold, which is the one that gates behaviour.

**8. One derived index on the absolute root.** A single daemon-managed
`ralph-decision-index` comment lists the active decisions beneath the root with
source links back to their canonical records. It is a *view*: regenerated from the
records, byte-identical on an unchanged ledger (nothing time-varying is rendered, so
an unchanged ledger performs **no write**), found by its fence tag and edited in
place so a restart can never plant a second one, and safe to delete.

**9. No SQLite projection in this slice.** GitHub is authoritative and every read
walks canonical comments, so "delete the local database" is not a recovery scenario
— it is the normal path. A projection may be added later purely as a cache; **no
decision may ever exist only in it.**

**10. No new config key.** The budget and ceiling are constants with per-call
overrides. Adding a daemon-only field to the mounted config would re-run the
unknown-keys-rejected compatibility failure documented in issue #19 against stale
container runners, for no benefit this slice needs.

## Considered options

- **Infer hierarchy from prose/labels** (`## Epic`, an `epic` label) — rejected:
  it is not a contract, it drifts, and it would silently mis-parent tickets. The
  native graph already exists and is authoritative.
- **A fixed level vocabulary** (initiative → epic → story) — rejected: it encodes a
  product taxonomy into the traversal, and the first four-level programme breaks it.
  Depth is a fact about the graph, not a schema.
- **Persist master conversation history** — rejected (ADR-0008 fresh context): a
  transcript is not a decision, cannot be folded, and rots. A structured, superseded-
  by-id record is replayable.
- **Last-writer-wins on a conflicted key** — rejected: it picks an architecture on a
  timestamp. Failing closed costs one adjudication; guessing costs a silent
  divergence nobody sees.
- **A SQLite decision table as the write path** — rejected: it would make the store
  authoritative for something GitHub can hold, breaking the rebuildable-store
  guarantee (ADR-0003/0021).

## Consequences

- `GitHubClient` grows four methods (`readIssueHierarchy`, `readIssueContent`,
  `postNodeComment`, `updateNodeComment`). Both implementations —
  `GhCliClient` and `FakeGitHub` — carry them, and the native contract is unit-tested
  on **both** with no network call.
- Every hierarchy/ledger surface keys on `IssueRef` (`owner/repo` + number) rather
  than a bare issue number, because cross-repo numbers collide.
- Pass one costs one GraphQL call per ancestor level, bounded by the ceiling; pass
  two costs one `issue view` per selected node. A sibling subtree costs nothing until
  someone asks for it.
- Payload evolution follows ADR-0026: the record schema is a *loose* object, so a
  field added by a later slice parses, round-trips, and is preserved. Required fields
  stay required; evolution is additive only.
- The master agent, its prompt, and the escalation path that would call any of this
  are deliberately out of scope — this slice ships the substrate and changes no
  existing behaviour.
