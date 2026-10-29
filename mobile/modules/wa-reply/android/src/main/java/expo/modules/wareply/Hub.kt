package expo.modules.wareply

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Asks the hub for a reply suggestion: POST /api/whatsapp/suggest. */
object Hub {
  class Suggestion(val text: String?, val error: String?)

  fun suggest(ctx: Context, name: String, text: String, isGroup: Boolean): Suggestion {
    val (url, token) = WaState.hub(ctx) ?: return Suggestion(null, "Open Orchestrator once to connect it to your hub.")
    return try {
      val conn = URL("$url/api/whatsapp/suggest").openConnection() as HttpURLConnection
      conn.requestMethod = "POST"
      conn.connectTimeout = 10_000
      conn.readTimeout = 150_000 // drafting runs a model; it can take a while
      conn.doOutput = true
      conn.setRequestProperty("Content-Type", "application/json")
      if (token.isNotEmpty()) conn.setRequestProperty("Authorization", "Bearer $token")
      conn.outputStream.use { it.write(JSONObject().put("name", name).put("text", text).put("isGroup", isGroup).toString().toByteArray()) }
      val ok = conn.responseCode in 200..299
      val body = (if (ok) conn.inputStream else conn.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
      conn.disconnect()
      val json = runCatching { JSONObject(body) }.getOrNull()
      if (!ok) return Suggestion(null, json?.optString("error")?.takeIf { it.isNotEmpty() } ?: "The hub answered ${conn.responseCode}.")
      val first = json?.optJSONArray("options")?.optJSONObject(0)?.optString("text")?.takeIf { it.isNotBlank() }
      Suggestion(first, if (first == null) "No reply needed, it seems." else null)
    } catch (e: Exception) {
      android.util.Log.w("WaReply", "hub request failed: ${e.javaClass.simpleName}: ${e.message}")
      Suggestion(null, "Can't reach your hub (${e.javaClass.simpleName}). Is Tailscale on?")
    }
  }
}
