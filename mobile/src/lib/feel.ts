import * as Haptics from "expo-haptics";
import { currentLook } from "./theme";

const when = (f: () => Promise<void>) => () => {
  if (currentLook().haptics) f().catch(() => {}); // a phone without a motor just stays still
};

/** What you feel: tap for any press, firm for a main button, tick for a switch, done for finishing something. */
export const feel = {
  tap: when(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  firm: when(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  tick: when(() => Haptics.selectionAsync()),
  done: when(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
};
