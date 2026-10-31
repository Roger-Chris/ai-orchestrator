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
  findApp(name: string): string | null;
  controlIsOn(): boolean;
  setControl(on: boolean): void;
  canStartApps(): boolean;
  openOverlaySettings(): void;
  openXiaomiPermissions(): void;
};

const native = requireOptionalNativeModule<WaReplyNative>("WaReply");

export const WaReply = {
  available: !!native,
  /** The native side keeps its own copy so suggestions work while the app is closed. */
  configure: (url: string, token: string) => native?.configure(url, token),
  isEnabled: () => native?.isEnabled() ?? false,
  openSettings: () => native?.openSettings(),
  /** An installed app's package, from the name you call it. */
  findApp: (name: string) => native?.findApp?.(name) ?? undefined,
  /** Remote control: Jarvis opens apps while the phone is in your pocket (ControlService). */
  control: {
    available: !!native?.setControl,
    isOn: () => native?.controlIsOn?.() ?? false,
    set: (on: boolean) => native?.setControl?.(on),
    canStartApps: () => native?.canStartApps?.() ?? false,
    openOverlaySettings: () => native?.openOverlaySettings?.(),
    openXiaomiPermissions: () => native?.openXiaomiPermissions?.(),
  },
};
