import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve, isAbsolute } from "node:path";
import { git } from "../cluster/branchwork.js";
import { runProcess } from "../providers/base.js";
import { slug } from "../shared/replica.js";
import { BuildError } from "./desk.js";

type Exec = typeof runProcess;

const IGNORE = "node_modules/\ndist/\nbuild/\n.expo/\n.env\n.env.*\n*.log\n__pycache__/\n.venv/\n";

/** True when `path` is inside the folder of projects the agents made themselves. */
export function insideProjects(path: string, projectsDir: string): boolean {
  const rel = relative(resolve(projectsDir), resolve(path));
  return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * A new project's home: a folder in `builds.projectsDir` and a PRIVATE GitHub repo (through the `gh`
 * sign-in on this machine). Building needs a remote, because the coding may happen on another device.
 * Asking for the same name again reuses the folder. This folder is the agents' authority: they
 * read, write and delete only in the projects they made here (see BuildDesk.start, files.trash).
 */
export async function createRepo(name: string, spec: string, o: { dir: string; remote: string; exec?: Exec }): Promise<string> {
  const exec = o.exec ?? runProcess;
  const base = slug(name) || "project";
  const dir = resolve(o.dir, base);
  const must = async (what: string, args: string[]) => {
    const r = await git(args, dir, exec);
    if (!r.ok) throw new BuildError(`${what} failed: ${(r.err || r.out).slice(-300)}`);
    return r;
  };
  mkdirSync(dir, { recursive: true });
  if (!existsSync(join(dir, ".git"))) {
    await must("git init", ["init", "--quiet", "--initial-branch=main"]);
    writeFileSync(join(dir, "README.md"), `# ${name}\n\n${spec.trim().slice(0, 2000)}\n`);
    writeFileSync(join(dir, ".gitignore"), IGNORE);
    await must("git add", ["add", "README.md", ".gitignore"]);
    await must("git commit", ["commit", "--quiet", "-m", `Start ${name}`]);
  }
  if ((await git(["remote", "get-url", o.remote], dir, exec)).ok) return dir;
  // The name may be taken on GitHub already: one retry with a suffix.
  let problem = "";
  for (const repo of [base, `${base}-${randomBytes(2).toString("hex")}`]) {
    const r = await exec({ command: "gh", args: ["repo", "create", repo, "--private", "--source", ".", "--remote", o.remote, "--push"], cwd: dir, timeoutMs: 120_000 });
    if (r.code === 0 && !r.spawnError) return dir;
    problem = r.spawnError || r.stderr || r.stdout;
    if (r.spawnError) break;
  }
  throw new BuildError(`could not create the GitHub repo (this machine needs \`gh\` signed in): ${problem.slice(-300)}`);
}
