/**
 * Elephant-Goldfish design mode (after Google's EGM method): an "elephant" with the
 * full task and codebase drafts a design; "goldfish" reviewers on other models see
 * only the document, so they catch what the author took for granted; you approve
 * before anything is built.
 */
import type { ProviderId } from "../types.js";

/** Reviewers we want, best first. Perplexity is a search engine, not a design reviewer. */
const GOLDFISH_ORDER: ProviderId[] = ["gemini", "codex", "claude"];

/**
 * Picks up to `count` reviewer models, never the author's when anything else is
 * available. Falls back to the author: a fresh session still has no shared context.
 */
export function pickGoldfish(available: Iterable<ProviderId>, author: ProviderId | undefined, count = 2): ProviderId[] {
  const have = new Set(available);
  const others = GOLDFISH_ORDER.filter((p) => have.has(p) && p !== author);
  if (others.length) return others.slice(0, count);
  return author && have.has(author) ? [author] : [];
}

export interface PriorRound {
  draft: string;
  reviews: { provider?: string; output: string }[];
  feedback: string;
}

export function elephantPrompt(task: string, prior?: PriorRound, context?: string): string {
  const base = `You are the ELEPHANT in an Elephant-Goldfish design process: you hold the full
context and write the design document BEFORE any code is written. If the task concerns an
existing codebase, explore the working folder first and cite real file paths. Do not edit files.

Write the document so a reviewer with NO other context can judge it: state every assumption.

Sections (markdown):
## Summary
## Goals and non-goals
## Context (existing code, constraints, prior decisions)
## Proposed design (components, data, interfaces, flows)
## Alternatives considered
## Risks and open questions
## Implementation plan (numbered, small, independently testable steps)
## Testing plan

Reply with ONLY the document.
${context ? `\nBACKGROUND (use it; the reviewers will not see it, so restate what matters):\n${context}\n` : ""}
TASK:
${task}`;
  if (!prior) return base;
  const reviews = prior.reviews.map((r, i) => `### Review ${i + 1}${r.provider ? ` (${r.provider})` : ""}\n${r.output}`).join("\n\n");
  return `${base}

---
This is a REVISION. Address the user's feedback first, then the review findings you agree with.
Add a final section "## Changes in this revision" listing what changed, and which findings you
declined and why.

USER FEEDBACK:
${prior.feedback}

PREVIOUS DRAFT:
${prior.draft}

GOLDFISH REVIEWS OF THE PREVIOUS DRAFT:
${reviews}`;
}

/** Deliberately carries no task text: the reviewer must judge the document on its own. */
export function goldfishPrompt(): string {
  return `You are a GOLDFISH reviewer. You have not seen the conversation or request that produced
the design document below, and that is the point: judge it only from what it says (and from source
files it references, if you can read them). Do not rewrite it.

Find:
- unstated assumptions and missing requirements
- ambiguity: places two engineers would build different things
- contradictions between sections
- risks to existing code, data, security or performance
- gaps in the implementation plan or testing plan

Reply with a numbered list of findings. For each: severity [blocker|major|minor], the section,
the problem, and a concrete fix. End with one line: VERDICT: APPROVE, APPROVE WITH CHANGES, or REWORK.`;
}

/** The task handed to the planner once you approve the design. */
export function implementationTask(task: string, design: string, notes?: string): string {
  return `${task}

Implement the APPROVED design below. Follow its implementation plan and testing plan; do not
redesign. Where it is silent, choose the simplest option consistent with it.${notes ? `\n\nThe user's decisions on the review findings:\n${notes}` : ""}

<approved-design>
${design}
</approved-design>`;
}

export function designSlug(task: string): string {
  const s = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
  return s || "design";
}
