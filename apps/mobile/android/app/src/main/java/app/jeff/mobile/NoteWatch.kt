package app.jeff.mobile

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.util.ArrayDeque
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 握手完成后接管接收方向：WebView 进后台会冻住，解密和「回复完成」通知只能留在这条套接字线程上。
 * 交给 JS 的是已经解开的明文，JS 只前进序号。
 */
object NoteWatch {
    data class Plain(val from: String, val n: Long, val json: String)

    private class Box(val key: ByteArray, var recvN: Long)

    private val lock = Any()
    private val boxes = HashMap<String, Box>()
    private val backlog = ArrayDeque<String>()
    private val inbox = ArrayDeque<String>()
    private val queued = ArrayDeque<Plain>()
    private var live = false
    var paused = false
    var onPlain: ((Plain) -> Unit)? = null
    var pendingKind = ""
    var pendingId = ""
    var pendingTitle = ""

    fun arm(peerId: String, recvKeyB64: String, recvN: Long) {
        synchronized(lock) {
            boxes[peerId] = Box(Base64.decode(recvKeyB64, Base64.DEFAULT), recvN)
            live = false
        }
    }

    /** 套接字上的原文。已接管的对端返回 true，调用方不要再交给 JS 解密。 */
    fun consume(text: String): Boolean {
        if (!owns(text)) return false
        val item = synchronized(lock) {
            if (live) openText(text) else {
                inbox.addLast(text)
                null
            }
        }
        if (item != null) onPlain?.invoke(item)
        return true
    }

    /** 交接前已经扣在 JS 里的帧，必须比套接字上后到的帧先解。 */
    fun feed(text: String) {
        synchronized(lock) { backlog.addLast(text) }
    }

    fun goLive() {
        val ready = ArrayList<Plain>()
        synchronized(lock) {
            while (backlog.isNotEmpty()) openText(backlog.removeFirst())?.let { ready.add(it) }
            while (inbox.isNotEmpty()) openText(inbox.removeFirst())?.let { ready.add(it) }
            live = true
        }
        val listener = onPlain
        if (listener != null) for (item in ready) listener.invoke(item)
    }

    fun disarm(peerId: String) {
        synchronized(lock) {
            boxes.remove(peerId)
            backlog.clear()
            inbox.clear()
            live = false
        }
    }

    fun pull(): JSONArray {
        val arr = JSONArray()
        synchronized(lock) {
            while (queued.isNotEmpty()) {
                val item = queued.removeFirst()
                val obj = JSONObject()
                obj.put("from", item.from)
                obj.put("n", item.n)
                obj.put("json", item.json)
                arr.put(obj)
            }
        }
        return arr
    }

    fun takeNote(): JSONObject {
        val obj = JSONObject()
        synchronized(lock) {
            obj.put("kind", pendingKind)
            obj.put("id", pendingId)
            obj.put("title", pendingTitle)
            pendingKind = ""
            pendingId = ""
            pendingTitle = ""
        }
        return obj
    }

    fun clear(peerId: String) {
        synchronized(lock) { boxes.remove(peerId) }
    }

    private fun owns(text: String): Boolean {
        val frame = try {
            JSONObject(text)
        } catch (_: Exception) {
            return false
        }
        if (frame.optString("t") != "e2e") return false
        val from = frame.optString("from")
        synchronized(lock) { return boxes.containsKey(from) }
    }

    private fun openText(text: String): Plain? {
        val frame = JSONObject(text)
        val from = frame.optString("from")
        val box = boxes[from] ?: return null
        val body = JSONObject(frame.getString("body"))
        val n = body.getLong("n")
        if (n != box.recvN) return null
        val plain = open(box.key, n, Base64.decode(body.getString("ct"), Base64.DEFAULT))
        box.recvN = n + 1
        val json = String(plain, Charsets.UTF_8)
        rememberNote(json)
        val item = Plain(from, n, json)
        if (paused || onPlain == null) {
            queued.addLast(item)
            return null
        }
        return item
    }

    private fun rememberNote(json: String) {
        val msg = try {
            JSONObject(json)
        } catch (_: Exception) {
            return
        }
        if (msg.optString("t") != "push" || msg.optString("what") != "note") return
        val p = msg.optJSONObject("p") ?: return
        pendingKind = p.optString("kind")
        pendingId = p.optString("id")
        pendingTitle = p.optString("title")
        val body = p.optString("body")
        val title = pendingTitle.ifEmpty { "Jeff" }
        RelayForegroundService.show(appContext ?: return, title, body, pendingKind, pendingId)
    }

    @Volatile
    var appContext: android.content.Context? = null

    fun open(key: ByteArray, n: Long, ct: ByteArray): ByteArray {
        val nonce = ByteArray(12)
        var x = n
        for (i in 11 downTo 4) {
            nonce[i] = (x and 0xff).toByte()
            x = x shr 8
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("jeff-frame-v1:$n".toByteArray(Charsets.UTF_8))
        return cipher.doFinal(ct)
    }
}
