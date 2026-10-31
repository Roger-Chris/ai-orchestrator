package expo.modules.wareply

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** Remote control comes back after a restart if you had it on. */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(ctx: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED && ControlService.isOn(ctx)) ControlService.set(ctx, true)
  }
}
