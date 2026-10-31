# Build guidelines

Every app, deck and video Jarvis builds follows this file; it goes into the coding agent's task. Change it freely: the setting `builds.guidelines` points here. Replace or extend it with your own standards.

## Always

- Small modules and plain, specific comments. No new dependency without a reason.
- Never put keys, tokens or passwords in the code. Keep them in `.env`, and commit a `.env.example`.
- Never delete files the owner made.
- Work only in this build's repo, on its own branch, never on `main`. The owner merges from the phone.
- Handle errors with messages that say what went wrong and what to do next.
- A README says what it is, how to run it and how to test it.

## Audits

Run every audit that applies and record it in `AUDIT.md` at the top of the repo, as a table: audit, command, result (pass, fail or not run), notes. Fix failures before finishing. Never write "pass" for something that did not run; write "not run" and say why.

### Apps

| Audit | What to do |
|---|---|
| Tests | Unit tests for the logic, and integration tests for anything that crosses a boundary. All pass |
| Types and lint | The project's typecheck and linter are clean |
| Build | The production build succeeds |
| Dependencies | `npm audit` or the language's equivalent: no high or critical issues |
| Secrets | Search the code and history for keys and tokens: none found |
| Security | Input validation, access control and injection reviewed for every endpoint and form |
| Accessibility | Labels, contrast and keyboard or screen-reader use, for anything with a UI |
| Performance | No obvious slow paths; note the bundle size for web apps |
| Docs | README is correct, and setup works from a clean clone |

### Decks and videos

| Audit | What to do |
|---|---|
| Opens | The file opens and plays; check it with a tool, not by assumption |
| Content | Every fact traces to the brief or a named source; nothing is invented |
| Quality | No clipped text or overlaps; readable at normal size; audio and picture in sync |
| Rights | Images, music and fonts may be used; note where each came from |

## Machines

- Never run an Android emulator or AVD on the Linux machine: it cannot take it. Use unit and component tests there.
- Android APKs and emulator testing belong on the Windows laptop, and only when the task needs them.
- Long or heavy work (video rendering, big builds) belongs on the laptop too.
