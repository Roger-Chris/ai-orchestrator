/** Escapes everything first, then adds a little formatting: safe to render as HTML. */
export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function md(src: string): string {
  const blocks: string[] = [];
  let s = esc(src).replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang: string, code: string) => {
    blocks.push(`<pre><code data-lang="${lang}">${code}</code></pre>`);
    return `\u0000${blocks.length - 1}\u0000`;
  });
  s = s
    .replace(/^#### (.*)$/gm, "<h4>$1</h4>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^# (.*)$/gm, "<h1>$1</h1>")
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  s = s.replace(/(?:^(?:[-*]|\d+\.) .*(?:\n|$))+/gm, (list) => {
    const ordered = /^\d+\./.test(list);
    const items = list
      .trim()
      .split("\n")
      .map((l) => `<li>${l.replace(/^(?:[-*]|\d+\.) /, "")}</li>`)
      .join("");
    return ordered ? `<ol>${items}</ol>` : `<ul>${items}</ul>`;
  });
  s = s
    .split(/\n{2,}/)
    .map((p) => (/^\s*<(h\d|ul|ol|pre)|^\u0000/.test(p) ? p : `<p>${p.replace(/\n/g, "<br>")}</p>`))
    .join("\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => blocks[+i]);
}

export function ago(ts: number): string {
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString();
}
