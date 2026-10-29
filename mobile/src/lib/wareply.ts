import { requireOptionalNativeModule } from "expo";

/**
 * Replies to WhatsApp from Orchestrator's notification (native module in modules/wa-reply). With
 * Notification access granted, the app sees WhatsApp's own notifications, asks the hub for a
 * suggestion and offers Send / Reply; WhatsApp itself sends what you pick. Absent on builds made
 * before the module existed, so every call is optional.
 */
type WaReplyNative = {
  configure(url: string, token: string): void;
  isEnabled(): boolean;
  openSettings(): void;
};

const native = requireOptionalNativeModule<WaReplyNative>("WaReply");

export const WaReply = {
  available: !!native,
  /** The native side keeps its own copy so suggestions work while the app is closed. */
  configure: (url: string, token: string) => native?.configure(url, token),
  isEnabled: () => native?.isEnabled() ?? false,
  openSettings: () => native?.openSettings(),
};
