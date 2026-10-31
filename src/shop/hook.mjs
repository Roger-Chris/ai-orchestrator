// The cart agent's check before each browser tool, run by Claude Code as a PreToolUse hook. Plain
// JavaScript, because it runs under node with no tsx. Exit 2 refuses the call and the agent reads why.
// Inside the run's stores the agent goes where it likes; it just can't carry anything off to another
// site or open a payment page. Any failure here refuses: Claude Code ignores other exit codes.
import { readFileSync } from "node:fs";

const refuse = (why) => {
  process.stderr.write(`${why} Don't look for a way round this: carry on within the stores, or say so in your note.`);
  process.exit(2);
};

try {
  const policy = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const { tool_name: tool, tool_input: input = {} } = JSON.parse(readFileSync(0, "utf8"));
  if (input.filename) refuse("Saving a page to a file is off.");
  if (/browser_(navigate|tabs)$/.test(tool) && input.url) {
    const url = new URL(input.url);
    const host = url.hostname.replace(/^www\./, "");
    if (url.protocol !== "https:" && url.protocol !== "http:") refuse(`${url.protocol} addresses are off.`);
    if (!policy.hosts.some((h) => host === h || host.endsWith(`.${h}`))) refuse(`${host} is not one of this run's stores.`);
    const cart = policy.carts.some((c) => { const u = new URL(c); return u.hostname === url.hostname && u.pathname === url.pathname; });
    if (!cart && new RegExp(policy.payPath, "i").test(url.pathname)) refuse("That is a checkout or payment page, which only the owner opens.");
  }
  process.exit(0);
} catch (e) {
  refuse(`The address could not be checked (${e.message}).`);
}
