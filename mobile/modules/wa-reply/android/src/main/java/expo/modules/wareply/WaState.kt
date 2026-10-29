package expo.modules.wareply

import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context

/**
 * One WhatsApp conversation we can answer: WhatsApp's own reply action from its notification.
 * Kept in memory only; it is valid while WhatsApp's notification for the chat is showing.
 */
data class Conversation(
  val key: String,
  val name: String,
  val isGroup: Boolean,
  /** The message to answer, "Sender: text" in groups. */
  val lastText: String,
  val reply: PendingIntent,
  val inputs: Array<RemoteInput>,
  /** Opens the chat in WhatsApp. */
  val open: PendingIntent?,
)

object WaState {
  val conversations = java.util.concurrent.ConcurrentHashMap<String, Conversation>()

  private const val PREFS = "wa_reply"

  /** The hub address and token, copied here by the app so suggestions work while it is closed. */
  fun hub(ctx: Context): Pair<String, String>? {
    val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val url = p.getString("hub", null) ?: return null
    return url to (p.getString("token", "") ?: "")
  }

  fun saveHub(ctx: Context, url: String, token: String) {
    ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("hub", url.trimEnd('/')).putString("token", token).apply()
  }

  /** Our notification for a conversation always uses the same id, so updates replace it. */
  fun notificationId(key: String) = 41_000 + (key.hashCode() and 0xffff)
}
