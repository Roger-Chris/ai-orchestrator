package expo.modules.wareply

import android.app.Notification
import android.os.Bundle
import android.os.Parcelable
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification
import android.util.Log

/**
 * Sees WhatsApp's notifications (nothing else) once you grant Notification access. For each new
 * message it keeps WhatsApp's reply action and shows Orchestrator's own notification: who wrote,
 * what they said, a suggested reply from the hub, and Send / Reply buttons that answer through
 * WhatsApp itself. Nothing is ever sent without your tap.
 */
class WaListenerService : NotificationListenerService() {
  override fun onListenerConnected() {
    Log.i(TAG, "connected")
    // WhatsApp messages already waiting when access was granted (or the app restarted).
    runCatching { activeNotifications }.getOrNull()?.forEach { onNotificationPosted(it) }
  }

  override fun onNotificationPosted(sbn: StatusBarNotification) {
    if (sbn.packageName !in WHATSAPP) return
    val n = sbn.notification
    if (n.flags and Notification.FLAG_GROUP_SUMMARY != 0) return
    val x = n.extras
    val isGroup = x.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false)
    val name = (x.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE) ?: x.getCharSequence(Notification.EXTRA_TITLE))
      ?.toString()?.replace(COUNT_SUFFIX, "")?.trim()?.takeIf { it.isNotEmpty() } ?: return skip("no title")
    val (sender, text) = lastMessage(x) ?: return skip("no message text")
    val key = sbn.key
    if (sender == null) {
      // Your own message is now the last one (you answered): nothing is waiting any more.
      WaState.conversations.remove(key)
      Notifier.cancel(this, key)
      return skip("last message is yours")
    }
    // Calls and other notifications without a reply box are not conversations we can answer.
    val action = n.actions?.firstOrNull { !it.remoteInputs.isNullOrEmpty() } ?: return skip("no reply action")
    val shown = if (isGroup) "$sender: $text" else text
    if (WaState.conversations[key]?.lastText == shown) return skip("same message again")
    Log.i(TAG, "message in ${if (isGroup) "group" else "chat"}; asking the hub")
    val c = Conversation(key, name, isGroup, shown, action.actionIntent, action.remoteInputs, n.contentIntent)
    WaState.conversations[key] = c
    Notifier.show(this, c, null, pending = true)
    Thread {
      val s = Hub.suggest(this, name, text, isGroup)
      // Only update if this is still the message waiting for an answer.
      if (WaState.conversations[key]?.lastText == shown) Notifier.show(this, c, s, pending = false)
    }.start()
  }

  override fun onNotificationRemoved(sbn: StatusBarNotification) {
    if (sbn.packageName !in WHATSAPP) return
    // You read the chat in WhatsApp (or cleared it): its reply action is gone, so is ours.
    WaState.conversations.remove(sbn.key)
    Notifier.cancel(this, sbn.key)
  }

  /** The newest message: sender (null = you) and text, from MessagingStyle or the plain text. */
  private fun lastMessage(x: Bundle): Pair<String?, String>? {
    @Suppress("DEPRECATION")
    val messages: Array<Parcelable>? = x.getParcelableArray(Notification.EXTRA_MESSAGES)
    val last = messages?.lastOrNull() as? Bundle
    if (last != null) {
      val text = last.getCharSequence("text")?.toString()?.takeIf { it.isNotBlank() } ?: return null
      @Suppress("DEPRECATION")
      val person = last.getParcelable<android.app.Person>("sender_person")
      val sender = person?.name?.toString() ?: last.getCharSequence("sender")?.toString()
      return sender to text
    }
    val text = x.getCharSequence(Notification.EXTRA_TEXT)?.toString()?.takeIf { it.isNotBlank() } ?: return null
    val title = x.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: return null
    return title to text
  }

  /** Why a WhatsApp notification was not answered (no message content in the log). */
  private fun skip(why: String) {
    Log.i(TAG, "skipped: $why")
  }

  companion object {
    private const val TAG = "WaReply"
    val WHATSAPP = setOf("com.whatsapp", "com.whatsapp.w4b")
    private val COUNT_SUFFIX = Regex("""\s*\(\d+\s+(new\s+)?messages?\)\s*$""", RegexOption.IGNORE_CASE)
  }
}
