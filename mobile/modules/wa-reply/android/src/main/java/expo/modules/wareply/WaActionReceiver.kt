package expo.modules.wareply

import android.app.RemoteInput
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Bundle

/** Your tap on Send suggestion or Reply: the text goes through WhatsApp's own reply action. */
class WaActionReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    val key = intent.getStringExtra("key") ?: return
    val text = when (intent.action) {
      SEND -> intent.getStringExtra("text")
      REPLY -> RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifier.KEY_TEXT)?.toString()
      else -> null
    }?.trim()
    if (text.isNullOrEmpty()) return
    val c = WaState.conversations[key]
    val sent = c != null && runCatching {
      val results = Bundle().apply { c.inputs.forEach { putCharSequence(it.resultKey, text) } }
      val fill = Intent()
      RemoteInput.addResultsToIntent(c.inputs, fill, results)
      c.reply.send(ctx, 0, fill)
    }.isSuccess
    if (sent) WaState.conversations.remove(key)
    Notifier.done(ctx, key, c?.name ?: "WhatsApp", text, sent, c?.open)
  }

  companion object {
    const val SEND = "expo.modules.wareply.SEND"
    const val REPLY = "expo.modules.wareply.REPLY"
  }
}
