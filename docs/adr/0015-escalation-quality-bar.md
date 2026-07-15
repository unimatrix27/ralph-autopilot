# The `escalate` tool enforces a quality bar — escalate-vs-decide-and-ADR, and zero-context readability

`escalate` (ADR-0004) already rejected an *incomplete* question — a missing or
empty required field. It now also rejects a *complete* one that does not clear the
**escalation quality bar**, because the operator's attention is the system's
scarcest resource and a wasteful (or non-existent) escalation is a product defect,
not a nit. The bar has two halves, both enforced at the tool boundary before any
checkpoint side effect runs.

**A. Escalate vs. decide-and-ADR.** Escalate ONLY a decision a human is genuinely
better-positioned to make: a product/behaviour choice, an ambiguous requirement,
an irreversible or external effect, a financial-correctness or UX trade-off, or a
hard blocker. Do **not** escalate an internal, behaviour-preserving structure /
layering / naming / abstraction call that the design of record or the repo's own
conventions already imply — per the [design-authority rule](0011-design-authority-rule.md)
the agent decides it and records an ADR. The tool flags an escalation that reads as
behaviour-preserving + structural with no human-relevant stake and sends the agent
back to decide-and-ADR.

**B. Zero-context readability.** `whereWeStand`/`stakes` must be rulable by a reader
who has not seen the diff: every domain term defined, each consequence in plain
architecture/user language. The tool rejects stakes that only parse with the code
open — bare file paths or code symbols.

## Considered Options / why this exists

A live escalation (legacy issue 9) asked the operator to choose the `store ↔ review` dependency
direction for a behaviour-preserving, build-green, internal layering refactor — a
one-way-door taste call handed to a human who had not read the diff, framed in terms
("the store layer", "a value-level edge") that only parse if you have. That is
exactly the design-resolvable call ADR-0011 says the agent must decide itself.

- **Leave the bar to the prompt alone** — rejected: the prompt is the primary
  mechanism, but a deterministic boundary check makes the two failure modes
  (design-resolvable, read-the-diff-only) *enforceable where enforceable*, the same
  way the required-field check is, so a bad escalation is bounced rather than
  reaching the operator.
- **Hard-fail aggressively** — rejected: the check is conservative (it bounces only
  a behaviour-preserving structural call with no human stake, or stakes carrying
  bare file/symbol tokens), and the rejection is instructive — decide-and-ADR, or
  rewrite for a zero-context reader — so even a false positive yields a *better*
  escalation, never a blocked one.

## Consequences

- The tool prompt encodes the bar (A), the zero-context readability rule (B), and a
  pre-send self-check: (1) "Can I resolve this from the design + conventions?" → if
  yes, decide + ADR; (2) "Would a non-implementer understand the stakes?" → if no,
  rewrite or don't send. The boundary check re-runs both so the self-check is not
  merely advisory.
- This is the quality sibling of ADR-0004's *completeness* check: together they make
  the escalation schema a forcing function for both a filled-in and a worth-the-
  operator's-attention question.
- Heal-cards (review-maxout) are daemon-authored, not agent-authored, and do not pass
  through this tool boundary; the bar governs agent escalations.
