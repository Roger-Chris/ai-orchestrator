/**
 * What the owner did with the hub's drafts, and what the brain learnt from that (AI_Assistant learn.py).
 * What was really sent goes to the brain; `writing` lessons come back for the next draft. Their message
 * to the owner is never sent, so nobody can steer a lesson by what they write. All best-effort: a brain
 * that is down must never hold up or fail a mail or a reply.
 */

export type DraftKind = "mail" | "whatsapp";

export interface DraftOutcome {
  kind: DraftKind;
  about?: string;
  draft: string;
  sent: string;
}

const STALE_MS = 10 * 60_000;

export class WritingLessons {
  private cache = new Map<DraftKind, { at: number; lessons: string[] }>();

  constructor(private o: { url: string; token: string; fetch?: typeof fetch; now?: () => number }) {}

  private call(path: string, init?: RequestInit) {
    return (this.o.fetch ?? fetch)(`${this.o.url.replace(/\/$/, "")}${path}`, { ...init, headers: { Authorization: `Bearer ${this.o.token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000) });
  }

  report(o: DraftOutcome): void {
    void this.call("/learn/drafts", { method: "POST", body: JSON.stringify({ ...o, about: o.about ?? "" }) }).catch(() => undefined);
  }

  /** What is known now, at once; a stale list is refreshed behind it for the next draft. */
  for(kind: DraftKind): string[] {
    const now = (this.o.now ?? Date.now)();
    const had = this.cache.get(kind);
    if (!had || now - had.at > STALE_MS) {
      this.cache.set(kind, { at: now, lessons: had?.lessons ?? [] });
      void this.call(`/learn/writing?kind=${kind}`)
        .then(async (r) => {
          if (r.ok) this.cache.set(kind, { at: now, lessons: ((await r.json()) as { lessons?: string[] }).lessons ?? [] });
        })
        .catch(() => undefined);
    }
    return had?.lessons ?? [];
  }
}

export const writingNote = (lessons: string[]) => (lessons.length ? `How I want this written, from changes I made to earlier drafts:\n${lessons.map((l) => `- ${l}`).join("\n")}` : "");
