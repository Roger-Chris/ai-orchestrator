package expo.modules.wareply

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent

/** Orchestrator's own notification for a WhatsApp message: who, what, a suggestion, Send / Reply. */
object Notifier {
  private const val CHANNEL = "whatsapp-replies"
  const val KEY_TEXT = "reply_text"

  private fun manager(ctx: Context): NotificationManager {
    val m = ctx.getSystemService(NotificationManager::class.java)
    if (m.getNotificationChannel(CHANNEL) == null) {
      m.createNotificationChannel(NotificationChannel(CHANNEL, "WhatsApp replies", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "Who wrote, what they said and a suggested reply; Send answers through WhatsApp."
      })
    }
    return m
  }

  private fun icon(ctx: Context): Int =
    ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName).takeIf { it != 0 } ?: android.R.drawable.sym_action_chat

  private fun broadcast(ctx: Context, c: Conversation, action: String, text: String?, mutable: Boolean): PendingIntent {
    val i = Intent(ctx, WaActionReceiver::class.java).setAction(action).putExtra("key", c.key)
    if (text != null) i.putExtra("text", text)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE)
    return PendingIntent.getBroadcast(ctx, (c.key + action).hashCode(), i, flags)
  }

  fun show(ctx: Context, c: Conversation, s: Hub.Suggestion?, pending: Boolean) {
    val suggestion = s?.text
    val detail = when {
      suggestion != null -> "Suggested: $suggestion"
      pending -> "Getting a suggestion…"
      else -> s?.error ?: ""
    }
    val reply = RemoteInput.Builder(KEY_TEXT).setLabel("Reply to ${c.name}").build()
    val b = Notification.Builder(ctx, CHANNEL)
      .setSmallIcon(icon(ctx))
      .setContentTitle("WhatsApp · ${c.name}")
      .setContentText(c.lastText)
      .setStyle(Notification.BigTextStyle().bigText("They: ${c.lastText}\n$detail"))
      .setCategory(Notification.CATEGORY_MESSAGE)
      .setAutoCancel(true)
      .setOnlyAlertOnce(true) // the suggestion arriving updates it quietly
      .addAction(Notification.Action.Builder(null, "Reply", broadcast(ctx, c, WaActionReceiver.REPLY, null, true)).addRemoteInput(reply).build())
    if (suggestion != null) b.addAction(Notification.Action.Builder(null, "Send suggestion", broadcast(ctx, c, WaActionReceiver.SEND, suggestion, false)).build())
    c.open?.let { b.setContentIntent(it) }
    manager(ctx).notify(WaState.notificationId(c.key), b.build())
  }

  /** After a reply: say it went (briefly), or how to send it by hand. */
  fun done(ctx: Context, key: String, name: String, text: String, sent: Boolean, open: PendingIntent?) {
    val b = Notification.Builder(ctx, CHANNEL).setSmallIcon(icon(ctx)).setOnlyAlertOnce(true).setAutoCancel(true)
    if (sent) {
      b.setContentTitle("Sent to $name").setContentText(text).setTimeoutAfter(5_000)
    } else {
      b.setContentTitle("Couldn't send to $name").setContentText("WhatsApp's notification is gone. Tap to open WhatsApp.")
        .setStyle(Notification.BigTextStyle().bigText("Your reply: $text\nWhatsApp's notification for this chat is gone, so it can't be answered from here. Tap to open WhatsApp."))
      open?.let { b.setContentIntent(it) }
    }
    manager(ctx).notify(WaState.notificationId(key), b.build())
  }

  fun cancel(ctx: Context, key: String) {
    ctx.getSystemService(NotificationManager::class.java).cancel(WaState.notificationId(key))
  }
}
