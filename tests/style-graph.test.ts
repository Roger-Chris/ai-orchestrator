import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readGraphFiles, saveGraphFiles } from "../src/whatsapp/graph.js";

const dirs: string[] = [];
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "orc-graph-"));
  dirs.push(d);
  return d;
};

describe("the people graph travels to the hub", () => {
  it("saves what was sent and reads it back", () => {
    const hub = temp();
    const files = { "graphify-out/graph.json": "{}", "people.md": "# People" };
    expect(saveGraphFiles(hub, files)).toEqual(Object.keys(files));
    expect(readFileSync(join(hub, "style/graph/people.md"), "utf8")).toBe("# People");
    expect(readGraphFiles(hub)).toEqual(files);
  });

  it("refuses any other name, and saves nothing from that request", () => {
    const hub = temp();
    expect(() => saveGraphFiles(hub, { "people.md": "ok", "../../.env": "x" })).toThrow(/not a graph file/);
    expect(existsSync(join(hub, "style/graph/people.md"))).toBe(false);
  });

  it("has nothing to send before a graph exists", () => {
    expect(readGraphFiles(temp())).toEqual({});
  });
});
