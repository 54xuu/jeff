package app.jeff.mobile

import android.Manifest
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Environment
import android.util.Base64
import androidx.activity.result.ActivityResult
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.google.zxing.integration.android.IntentIntegrator
import java.io.ByteArrayOutputStream
import java.io.File
import kotlin.math.max
import kotlin.math.min

@CapacitorPlugin(name = "JeffSpike")
class JeffSpikePlugin : Plugin() {
    private var cache: CacheDb? = null

    @PluginMethod
    fun cryptoSelfTest(call: PluginCall) {
        val ret = JSObject()
        try {
            ret.put("ok", true)
            ret.put("detail", CryptoSelfTest.run(context))
        } catch (err: Exception) {
            ret.put("ok", false)
            ret.put("detail", err.message ?: "原生加密自检失败")
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun startForeground(call: PluginCall) {
        ContextCompat.startForegroundService(context, android.content.Intent(context, RelayForegroundService::class.java))
        call.resolve()
    }

    @PluginMethod
    fun openSocket(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("缺少地址")
        val pin = call.getString("pin") ?: ""
        RelaySocket.onText = { text ->
            if (!NoteWatch.consume(text)) {
                val data = JSObject()
                data.put("text", text)
                notifyListeners("frame", data)
            }
        }
        RelaySocket.onClosed = { reason ->
            val data = JSObject()
            data.put("text", "")
            data.put("closed", reason)
            notifyListeners("frame", data)
        }
        try {
            RelaySocket.open(url, pin)
            call.resolve()
        } catch (err: Exception) {
            call.reject(err.message)
        }
    }

    @PluginMethod
    fun sendText(call: PluginCall) {
        val text = call.getString("text") ?: return call.reject("缺少内容")
        try {
            RelaySocket.send(text)
            call.resolve()
        } catch (err: Exception) {
            call.reject(err.message)
        }
    }

    @PluginMethod
    fun closeSocket(call: PluginCall) {
        RelaySocket.close()
        call.resolve()
    }

    companion object {
        var instance: JeffSpikePlugin? = null
    }

    fun dispatchBack() {
        notifyListeners("back", JSObject())
    }

    override fun load() {
        instance = this
        NoteWatch.appContext = context
        try {
            android.util.Log.i("JeffCrypto", CryptoSelfTest.run(context))
        } catch (err: Exception) {
            android.util.Log.e("JeffCrypto", err.message ?: "原生加密自检失败")
        }
        NoteWatch.onPlain = { item ->
            val data = JSObject()
            data.put("from", item.from)
            data.put("n", item.n)
            data.put("json", item.json)
            notifyListeners("plain", data)
        }
    }

    override fun handleOnDestroy() {
        if (instance == this) instance = null
        super.handleOnDestroy()
    }

    @PluginMethod
    fun armRecv(call: PluginCall) {
        val peerId = call.getString("peerId") ?: return call.reject("缺少对端")
        val recvKey = call.getString("recvKey") ?: return call.reject("缺少密钥")
        NoteWatch.arm(peerId, recvKey, (call.getInt("recvN") ?: 0).toLong())
        call.resolve()
    }

    @PluginMethod
    fun feedFrame(call: PluginCall) {
        NoteWatch.feed(call.getString("text") ?: return call.reject("缺少帧"))
        call.resolve()
    }

    @PluginMethod
    fun goLive(call: PluginCall) {
        NoteWatch.goLive()
        call.resolve()
    }

    @PluginMethod
    fun disarmRecv(call: PluginCall) {
        NoteWatch.disarm(call.getString("peerId") ?: "")
        call.resolve()
    }

    @PluginMethod
    fun pullPlain(call: PluginCall) {
        val ret = JSObject()
        ret.put("items", NoteWatch.pull())
        call.resolve(ret)
    }

    @PluginMethod
    fun takeNote(call: PluginCall) {
        val note = NoteWatch.takeNote()
        var kind = note.optString("kind")
        var id = note.optString("id")
        var title = note.optString("title")
        val intent = activity?.intent
        if (id.isEmpty() && intent != null) {
            kind = intent.getStringExtra("jeff_note_kind") ?: ""
            id = intent.getStringExtra("jeff_note_id") ?: ""
            title = intent.getStringExtra("jeff_note_title") ?: ""
        }
        intent?.removeExtra("jeff_note_kind")
        intent?.removeExtra("jeff_note_id")
        intent?.removeExtra("jeff_note_title")
        val ret = JSObject()
        ret.put("kind", kind)
        ret.put("id", id)
        ret.put("title", title)
        call.resolve(ret)
    }

    override fun handleOnPause() {
        NoteWatch.paused = true
        super.handleOnPause()
    }

    override fun handleOnResume() {
        NoteWatch.paused = false
        super.handleOnResume()
        notifyListeners("resume", JSObject())
    }

    @PluginMethod
    fun notify(call: PluginCall) {
        RelayForegroundService.show(
            context,
            call.getString("title") ?: "Jeff",
            call.getString("body") ?: "",
            call.getString("kind") ?: "",
            call.getString("id") ?: "",
        )
        call.resolve()
    }

    @PluginMethod
    fun scan(call: PluginCall) {
        val host = activity
        if (host == null) {
            call.reject("没有界面")
            return
        }
        val integrator = IntentIntegrator(host)
        integrator.setCaptureActivity(CustomScannerActivity::class.java)
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
        integrator.setPrompt("")
        integrator.setBeepEnabled(false)
        // 清单里已经锁了竖屏。这里再锁一次会让界面重建，摄像头还在，解码器已经丢了。
        integrator.setOrientationLocked(false)
        startActivityForResult(call, integrator.createScanIntent(), "onScan")
    }

    @ActivityCallback
    private fun onScan(call: PluginCall, result: ActivityResult) {
        val parsed = IntentIntegrator.parseActivityResult(result.resultCode, result.data)
        if (parsed?.contents.isNullOrEmpty()) {
            call.reject("已取消")
            return
        }
        val ret = JSObject()
        ret.put("text", parsed.contents)
        call.resolve(ret)
    }

    @PluginMethod
    fun pickImage(call: PluginCall) {
        val intent = android.content.Intent(android.content.Intent.ACTION_GET_CONTENT).setType("image/*")
        startActivityForResult(call, intent, "onImage")
    }

    @ActivityCallback
    private fun onImage(call: PluginCall, result: ActivityResult) {
        val uri = result.data?.data
        if (uri == null) {
            call.reject("已取消")
            return
        }
        val raw = context.contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it) }
        if (raw == null) {
            call.reject("读不到图片")
            return
        }
        val maxEdge = 1600f
        val scale = min(1f, maxEdge / max(raw.width, raw.height))
        val scaled = if (scale < 1f) Bitmap.createScaledBitmap(raw, (raw.width * scale).toInt().coerceAtLeast(1), (raw.height * scale).toInt().coerceAtLeast(1), true) else raw
        val bytes = ByteArrayOutputStream()
        scaled.compress(Bitmap.CompressFormat.JPEG, 80, bytes)
        val ret = JSObject()
        ret.put("dataUrl", "data:image/jpeg;base64," + Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP))
        call.resolve(ret)
    }

    @PluginMethod
    fun unlock(call: PluginCall) {
        val host = activity as? FragmentActivity
        if (host == null) {
            call.reject("没有界面")
            return
        }
        val authenticators = if (Build.VERSION.SDK_INT >= 30) {
            BiometricManager.Authenticators.BIOMETRIC_STRONG or BiometricManager.Authenticators.DEVICE_CREDENTIAL
        } else {
            BiometricManager.Authenticators.BIOMETRIC_WEAK
        }
        if (BiometricManager.from(context).canAuthenticate(authenticators) != BiometricManager.BIOMETRIC_SUCCESS) {
            val ret = JSObject()
            ret.put("ok", true)
            ret.put("skipped", true)
            call.resolve(ret)
            return
        }
        host.runOnUiThread {
            try {
                val prompt = BiometricPrompt(host, ContextCompat.getMainExecutor(context), object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val ret = JSObject()
                        ret.put("ok", true)
                        call.resolve(ret)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        call.reject(errString.toString())
                    }
                })
                val info = BiometricPrompt.PromptInfo.Builder().setTitle("解锁 Jeff").setAllowedAuthenticators(authenticators).build()
                prompt.authenticate(info)
            } catch (err: Exception) {
                call.reject(err.message ?: "解锁失败")
            }
        }
    }

    @PluginMethod
    fun cacheGet(call: PluginCall) {
        val db = cache ?: CacheDb(context).also { cache = it }
        val ret = JSObject()
        ret.put("json", db.get(call.getString("desktopId") ?: "", call.getString("key") ?: ""))
        call.resolve(ret)
    }

    @PluginMethod
    fun cachePut(call: PluginCall) {
        val db = cache ?: CacheDb(context).also { cache = it }
        db.put(call.getString("desktopId") ?: "", call.getString("key") ?: "", call.getString("json") ?: "")
        call.resolve()
    }

    @PluginMethod
    fun readDebugPair(call: PluginCall) {
        val file = File(context.getExternalFilesDir(null), "pair.json")
        val ret = JSObject()
        ret.put("text", if (file.exists()) file.readText() else "")
        if (file.exists()) file.delete()
        call.resolve(ret)
    }

    @PluginMethod
    fun minimize(call: PluginCall) {
        activity?.moveTaskToBack(true)
        call.resolve()
    }

    @PluginMethod
    fun openBattery(call: PluginCall) {
        val intent = android.content.Intent(android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
        intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
        context.startActivity(intent)
        call.resolve()
    }

    /**
     * 请求电池优化豁免：已授权时静默跳过（skipped=true）。
     * 由 JS 在「已绑定电脑」后调用，替代老版冷启动无条件弹窗——
     * 那个弹窗在每次冷启动都出现，且弹窗期间应用完全不可交互。
     */
    @PluginMethod
    fun requestBattery(call: PluginCall) {
        val ret = JSObject()
        if (Build.VERSION.SDK_INT < 23) {
            ret.put("ok", true)
            ret.put("skipped", true)
            call.resolve(ret)
            return
        }
        val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
        if (pm == null || pm.isIgnoringBatteryOptimizations(context.packageName)) {
            ret.put("ok", true)
            ret.put("skipped", true)
            call.resolve(ret)
            return
        }
        try {
            val intent = android.content.Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
            intent.data = android.net.Uri.parse("package:${context.packageName}")
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            ret.put("ok", true)
            call.resolve(ret)
        } catch (err: Exception) {
            ret.put("ok", false)
            ret.put("skipped", true)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun getPersistedProfile(call: PluginCall) {
        val prefs = context.getSharedPreferences("jeff_profile", Context.MODE_PRIVATE)
        var json = prefs.getString("profile_json", "") ?: ""
        if (json.isEmpty()) {
            // 尝试从备用文件读取（应对 apk 卸载后重装场景）
            val files = listOf(
                File(context.getExternalFilesDir(null), "profile_backup.json"),
                File(context.getExternalFilesDir("backup"), "profile.json"),
                File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), ".jeff_profile_backup.json")
            )
            for (f in files) {
                try {
                    if (f.exists() && f.length() > 0) {
                        val content = f.readText()
                        if (content.contains("identity") || content.contains("signSecret")) {
                            json = content
                            prefs.edit().putString("profile_json", json).apply()
                            break
                        }
                    }
                } catch (_: Exception) {}
            }
        }
        val ret = JSObject()
        ret.put("profileJson", json)
        call.resolve(ret)
    }

    @PluginMethod
    fun savePersistedProfile(call: PluginCall) {
        val json = call.getString("profileJson") ?: return call.reject("缺少 profileJson")
        val prefs = context.getSharedPreferences("jeff_profile", Context.MODE_PRIVATE)
        prefs.edit().putString("profile_json", json).apply()
        val files = listOf(
            File(context.getExternalFilesDir(null), "profile_backup.json"),
            File(context.getExternalFilesDir("backup"), "profile.json"),
            File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), ".jeff_profile_backup.json")
        )
        for (f in files) {
            try {
                f.parentFile?.mkdirs()
                f.writeText(json)
            } catch (_: Exception) {}
        }
        call.resolve()
    }

    @Suppress("unused")
    private fun cameraPermission() = Manifest.permission.CAMERA
}
