import { createSocket } from "node:dgram";

/** A Wake-on-LAN magic packet: 6 x 0xFF, then the MAC 16 times. */
export function magicPacket(mac: string): Buffer {
  const hex = mac.replace(/[^0-9a-f]/gi, "");
  if (hex.length !== 12) throw new Error(`not a MAC address: ${mac}`);
  const m = Buffer.from(hex, "hex");
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array<Buffer>(16).fill(m)]);
}

/** Broadcast on this LAN: it reaches a sleeping device only on the hub's own network, never over Tailscale. */
export function sendWake(mac: string): Promise<void> {
  const packet = magicPacket(mac);
  const sock = createSocket("udp4");
  return new Promise((ok, no) => {
    sock.once("error", (e) => (sock.close(), no(e)));
    sock.bind(() => {
      sock.setBroadcast(true);
      sock.send(packet, 9, "255.255.255.255", (e) => {
        sock.close();
        if (e) no(e);
        else ok();
      });
    });
  });
}
