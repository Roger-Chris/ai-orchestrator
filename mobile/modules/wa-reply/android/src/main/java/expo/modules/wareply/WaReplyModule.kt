package expo.modules.wareply

import android.content.Context
import android.content.Intent
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/** What the app's JavaScript can do: hand over the hub details, check access, open Android's switch. */
class WaReplyModule : Module() {
  private val ctx: Context
    get() = requireNotNull(appContext.reactContext) { "no Android context" }

  override fun definition() = ModuleDefinition {
    Name("WaReply")

    Function("configure") { url: String, token: String -> WaState.saveHub(ctx, url, token) }

    /** Notification access granted to this app? */
    Function("isEnabled") {
      Settings.Secure.getString(ctx.contentResolver, "enabled_notification_listeners")?.contains(ctx.packageName) == true
    }

    Function("openSettings") {
      ctx.startActivity(Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
  }
}
