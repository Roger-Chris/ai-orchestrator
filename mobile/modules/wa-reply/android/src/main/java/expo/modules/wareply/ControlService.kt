package expo.modules.wareply

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Lets Jarvis open an app on this phone when you ask from anywhere, with the phone in your pocket.
 *
 * You turn it on in Settings. While on it shows a permanent notification, so you can always see it is
 * running, and asks the hub every few seconds for an "open this app" request. It does nothing else:
 * alarms, calls, texts and files still wait for your tap on the Phone screen.
 *
 * Android only lets a background app start another app with "Display over other apps" granted
 * (and on Xiaomi, "Display pop-up windows while running in the background").
 */
class ControlService : Service() {
  @Volatile private var running = false

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    show()
    if (!running) {
      running = true
      Thread({ loop() }, "jarvis-control").start()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  private fun show() {
    val nm = getSystemService(NotificationManager::class.java)
    nm.createNotificationChannel(NotificationChannel(CHANNEL, "Jarvis remote control", NotificationManager.IMPORTANCE_LOW))
    val open = packageManager.getLaunchIntentForPackage(packageName)?.let {
      android.app.PendingIntent.getActivity(this, 0, it, android.app.PendingIntent.FLAG_IMMUTABLE)
    }
    val n: Notification = Notification.Builder(this, CHANNEL)
      .setContentTitle("Jarvis can open apps on this phone")
      .setContentText("Turn this off in Orchestrator's Settings.")
      .setSmallIcon(applicationInfo.icon)
      .setOngoing(true)
      .setContentIntent(open)
      .build()
    if (Build.VERSION.SDK_INT >= 34) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    else startForeground(ID, n)
  }

  private fun loop() {
    while (running) {
      runCatching { check() }.onFailure { android.util.Log.d("JarvisControl", "hub: ${it.message}") }
      try {
        Thread.sleep(POLL_MS)
      } catch (_: InterruptedException) {
        return
      }
    }
  }

  private fun check() {
    val (url, token) = WaState.hub(this) ?: return
    val list = JSONArray(request("$url/api/phone/actions?status=pending", token, null))
    for (i in 0 until list.length()) {
      val p = list.getJSONObject(i)
      val a = p.optJSONObject("action") ?: continue
      // Old requests are left for the Phone screen: an app popping up long after you asked would be a surprise.
      if (a.optString("kind") != "open_app" || System.currentTimeMillis() - p.optLong("createdAt") > MAX_AGE_MS) continue
      val pkg = a.optString("package").ifEmpty { null } ?: Apps.find(this, a.optString("app")) ?: continue
      val launch = packageManager.getLaunchIntentForPackage(pkg)?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) ?: continue
      startActivity(launch)
      request("$url/api/phone/actions/${p.getString("id")}/done", token, JSONObject())
    }
  }

  private fun request(address: String, token: String, body: JSONObject?): String {
    val conn = URL(address).openConnection() as HttpURLConnection
    conn.connectTimeout = 8_000
    conn.readTimeout = 15_000
    if (token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
    if (body != null) {
      conn.requestMethod = "POST"
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      conn.outputStream.use { it.write(body.toString().toByteArray()) }
    }
    return try {
      if (conn.responseCode !in 200..299) throw java.io.IOException("HTTP ${conn.responseCode}")
      conn.inputStream.bufferedReader().use { it.readText() }
    } finally {
      conn.disconnect()
    }
  }

  companion object {
    private const val CHANNEL = "jarvis_control"
    private const val ID = 42_001
    private const val POLL_MS = 6_000L
    private const val MAX_AGE_MS = 3 * 60_000L
    private const val PREFS = "jarvis_control"

    fun isOn(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("on", false)

    fun set(ctx: Context, on: Boolean) {
      ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean("on", on).apply()
      val i = Intent(ctx, ControlService::class.java)
      if (on) ctx.startForegroundService(i) else ctx.stopService(i)
    }
  }
}

/** Finds an installed app by the name you call it, from what the launcher shows. */
object Apps {
  fun find(ctx: Context, name: String): String? {
    val want = name.trim().lowercase()
    if (want.isEmpty()) return null
    val pm = ctx.packageManager
    val all = pm.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
      .map { it.loadLabel(pm).toString().lowercase() to it.activityInfo.packageName }
    return (all.firstOrNull { it.first == want } ?: all.firstOrNull { it.first.contains(want) })?.second
  }
}
