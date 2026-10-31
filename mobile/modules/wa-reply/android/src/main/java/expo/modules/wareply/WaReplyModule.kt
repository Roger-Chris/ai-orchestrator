package expo.modules.wareply

import android.content.Context
import android.content.Intent
import android.net.Uri
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

    // ---- remote control: opening apps when you ask from anywhere (ControlService)
    Function("findApp") { name: String -> Apps.find(ctx, name) }
    Function("controlIsOn") { ControlService.isOn(ctx) }
    Function("setControl") { on: Boolean -> ControlService.set(ctx, on) }
    Function("canStartApps") { Settings.canDrawOverlays(ctx) }
    Function("openOverlaySettings") {
      ctx.startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
    // Xiaomi keeps its own switch for this ("Display pop-up windows while running in the background").
    Function("openXiaomiPermissions") {
      val miui = Intent("miui.intent.action.APP_PERM_EDITOR")
        .setClassName("com.miui.securitycenter", "com.miui.permcenter.permissions.PermissionsEditorActivity")
        .putExtra("extra_pkgname", ctx.packageName)
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        ctx.startActivity(miui)
      } catch (_: Exception) {
        ctx.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${ctx.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }
  }
}
