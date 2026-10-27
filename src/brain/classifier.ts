import { type Classification, TASK_KINDS, type TaskKind } from "../types.js";

/** Weighted keyword signals per kind. Fast and free; the planner refines complex tasks. */
const SIGNALS: Record<TaskKind, [RegExp, number][]> = {
  system_design: [
    [/\b(architect(ure)?|system design|design (a|the) system|scalab\w*|microservices?|high.?level design|data ?model|schema design|tech stack)\b/i, 3],
    [/\b(api design|infrastructure|distributed|event.?driven|queue|sharding)\b/i, 1.5],
  ],
  ui_ux: [
    [/\b(ui|ux|user interface|user experience|wireframes?|mockups?|figma|landing page|design system|layout|accessibility|a11y)\b/i, 3],
    [/\b(css|tailwind|components?|responsive|color palette|typography|onboarding flow)\b/i, 1.5],
  ],
  coding: [
    [/\b(implement|write (a |the )?(function|script|code|program|class)|build (a|an|the)|refactor|add (a )?feature|endpoints?|cli tool)\b/i, 3],
    [/\b(typescript|javascript|python|rust|golang|java|c\+\+|react|node|django|fastapi|sql)\b/i, 1.5],
    [/```/, 1],
  ],
  debugging: [[/\b(bug|fix|error|exception|stack ?trace|crash(es)?|fails?|failing|broken|not working|traceback|segfault)\b/i, 3]],
  code_review: [[/\b(review|audit|code quality|security review|pull request|pr|critique (the|this|my) code)\b/i, 3]],
  reasoning: [
    [/\b(reason(ing)?|logic(al)?|puzzle|trade.?offs?|pros and cons|decide|decision|evaluate|compare|why|proof|deduce|think through)\b/i, 2.5],
  ],
  math: [[/\b(math|equation|integral|derivative|probability|statistics?|theorem|calculate|optimi[sz]ation problem|algebra)\b/i, 3]],
  research: [
    [/\b(research|find (out|sources|papers)|latest|current|news|state of the art|market|competitors?|cite|sources|look up|search the web|compare prices|datasheets?)\b/i, 3],
    [/\b(20\d\d|today|this (week|month|year)|recent)\b/i, 1],
  ],
  writing: [[/\b(write (an? )?(article|blog|email|essay|post|report|doc(umentation)?|readme|proposal)|rewrite|summari[sz]e|copy ?writing|tone)\b/i, 3]],
  long_context: [[/\b(entire (codebase|repo|book)|whole (repo|document)|long document|hundreds of pages|large file|all the files)\b/i, 3]],
  multimodal: [[/\b(image|screenshot|photo|video|audio|pdf|scan|ocr)\b/i, 2.5]],
  pcb_design: [
    [/\b(pcb|schematic|kicad|eagle|altium|easyeda|gerbers?|footprints?|netlist|skidl|atopile|circuit board|trace width|bom|bill of materials)\b/i, 4],
    [/\b(microcontroller|esp32|stm32|arduino|resistors?|capacitors?|mosfets?|regulator|op.?amp|impedance)\b/i, 1.5],
  ],
  cad_3d: [[/\b(3d models?|cad|openscad|cadquery|freecad|blender|stl|step file|mesh|enclosure|3d print(ed|ing)?|fusion 360|solidworks|parametric)\b/i, 4]],
  data_analysis: [[/\b(dataset|csv|excel|spreadsheet|pandas|analy[sz]e (the )?data|visuali[sz]e|dashboard|metrics|regression|plot)\b/i, 3]],
  quick: [],
};

const WORKSPACE = /\b(in (this|my|the) (repo|project|codebase|folder)|edit (the )?files?|modify|commit|run (the )?tests?|npm|pip install|create (the )?files?|scaffold)\b/i;
const WEB = /\b(latest|current|today|news|prices?|search the web|look up|sources|cite|20\d\d)\b/i;

function countMatches(re: RegExp, text: string): number {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  return (text.match(g) ?? []).length;
}

export function classify(task: string): Classification {
  const scores: Partial<Record<TaskKind, number>> = {};
  for (const [kind, sigs] of Object.entries(SIGNALS) as [TaskKind, [RegExp, number][]][]) {
    let s = 0;
    for (const [re, w] of sigs) s += w * Math.min(countMatches(re, task), 3);
    if (s > 0) scores[kind] = s;
  }

  const ranked = (Object.entries(scores) as [TaskKind, number][]).sort((a, b) => b[1] - a[1]);
  const words = task.trim().split(/\s+/).length;
  const kind: TaskKind = ranked[0]?.[0] ?? (words < 25 ? "quick" : "reasoning");
  const top = ranked[0]?.[1] ?? 0;
  const alsoKinds = ranked.slice(1).filter(([, s]) => s >= Math.max(2.5, top * 0.5)).map(([k]) => k);

  const multiPart = countMatches(/\b(then|and also|after that|finally)\b|^\s*(?:[-*]|\d+[.)])\s/im, task);
  const bigBuild = /\b(build|create|design|develop|make)\b.{0,40}\b(app|application|system|platform|product|website|device|board|robot|game|service)\b/i.test(task);
  const complexity: Classification["complexity"] =
    alsoKinds.length >= 2 || multiPart >= 3 || (bigBuild && words > 15) || words > 250
      ? "complex"
      : alsoKinds.length === 1 || multiPart >= 1 || bigBuild || words > 80
        ? "moderate"
        : "simple";

  return {
    kind,
    alsoKinds,
    complexity,
    needsWeb: WEB.test(task) || kind === "research",
    needsWorkspace: WORKSPACE.test(task),
    scores,
  };
}

/** Asks a fast model what kind of work a task is; the answer refines the keyword guess. */
export function classifyPrompt(task: string): string {
  return [
    "Classify this task for a router that sends work to AI models. Answer with JSON only:",
    `{"kind":"<one of: ${TASK_KINDS.join(", ")}>","complexity":"simple|moderate|complex","needsWeb":true|false,"needsWorkspace":true|false}`,
    "simple: one model can answer it in one go. moderate: a few parts. complex: several different kinds of work that need a plan.",
    "needsWeb: needs current information from the internet. needsWorkspace: must read or change files in a project folder.",
    "",
    "TASK:",
    task.length > 4000 ? `${task.slice(0, 4000)}…` : task,
  ].join("\n");
}

/** The model's answer merged over the keyword classification; anything invalid keeps the keyword value. */
export function refineClassification(c: Classification, answer: string): Classification {
  let m: any;
  try {
    m = JSON.parse(answer.slice(answer.indexOf("{"), answer.lastIndexOf("}") + 1));
  } catch {
    return c;
  }
  const kind = (TASK_KINDS as readonly string[]).includes(m?.kind) ? (m.kind as TaskKind) : c.kind;
  const complexity = ["simple", "moderate", "complex"].includes(m?.complexity) ? m.complexity : c.complexity;
  return {
    ...c,
    kind,
    alsoKinds: c.alsoKinds.filter((k) => k !== kind),
    complexity,
    // Keywords like "latest" or "edit the files" are strong signals; the model can add, not remove, them.
    needsWeb: c.needsWeb || m?.needsWeb === true,
    needsWorkspace: c.needsWorkspace || m?.needsWorkspace === true,
  };
}
