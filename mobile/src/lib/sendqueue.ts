/**
 * One pass over the recordings waiting to be sent, oldest first. No Expo imports, so the hub's
 * vitest can test it. An item leaves only after `send` succeeded; a failure stays for the next
 * pass, and it never stops the others (one rejected file must not hold up the rest).
 */
export interface Waiting {
  id: string;
  uri: string;
  seconds: number;
  at: number;
  error?: string;
}

export async function sendAll(items: Waiting[], send: (w: Waiting) => Promise<void>, changed: (left: Waiting[]) => Promise<void>): Promise<Waiting[]> {
  let left = [...items].sort((a, b) => a.at - b.at);
  for (const w of [...left]) {
    try {
      await send(w);
      left = left.filter((x) => x.id !== w.id);
    } catch (e) {
      left = left.map((x) => (x.id === w.id ? { ...x, error: (e as Error).message } : x));
    }
    await changed(left);
  }
  return left;
}
