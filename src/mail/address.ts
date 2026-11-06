/** One real address; nothing with spaces, a second @ or no domain. */
export const ADDRESS = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

const DIGITS: Record<string, string> = { zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9" };

/**
 * An address as speech recognition writes it: "roger inventor 1914 at gmail dot com", "Roger inventor
 * 1914@gmail.com", "one nine one four at the rate gmail dot com". Returns it joined up, or undefined
 * when these words are not an address ("Priya at work" has no domain, so it stays a name).
 */
export function spokenEmail(words: string): string | undefined {
  const joined = words
    .trim()
    .toLowerCase()
    .replace(/\b(at the rate of|at the rate|at sign|at)\b/g, "@")
    .replace(/\b(dot|period|point)\b/g, ".")
    .replace(/\b(underscore|under score)\b/g, "_")
    .replace(/\b(hyphen|dash)\b/g, "-")
    .replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine)\b/g, (d) => DIGITS[d])
    .replace(/\s+/g, "");
  return ADDRESS.test(joined) ? joined : undefined;
}

/** "Priya Nair <priya@x.com>, b@y.com" -> each name and address. */
export function parseAddresses(header: string): { name: string; address: string }[] {
  return header
    .split(",")
    .map((part) => {
      const m = part.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
      return m ? { name: m[1].trim(), address: m[2].trim().toLowerCase() } : { name: "", address: part.trim().toLowerCase() };
    })
    .filter((a) => ADDRESS.test(a.address));
}

/** The address belongs to this person when every word of the name is in its display name or local part. */
export function matchesName(a: { name: string; address: string }, name: string): boolean {
  const hay = `${a.name} ${a.address.split("@")[0]}`.toLowerCase();
  const words = name.toLowerCase().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.every((w) => hay.includes(w));
}
