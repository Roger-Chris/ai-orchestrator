import { Linking, Share } from "react-native";

/**
 * Opens WhatsApp with `text` filled in, ready for you to press send (the app never sends by itself).
 * With the chat's number it opens that chat; the hub learns the numbers of hidden-id chats from the
 * WhatsApp link. Without one, WhatsApp's own chat picker, and the share menu only if WhatsApp is missing.
 */
export async function openWhatsApp(text: string, phone?: string): Promise<void> {
  const t = encodeURIComponent(text);
  if (phone) return Linking.openURL(`https://wa.me/${phone}?text=${t}`);
  try {
    await Linking.openURL(`whatsapp://send?text=${t}`);
  } catch {
    await Share.share({ message: text });
  }
}
