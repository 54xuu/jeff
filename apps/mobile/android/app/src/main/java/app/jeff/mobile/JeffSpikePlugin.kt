package app.jeff.mobile

import android.content.Intent
import androidx.core.content.ContextCompat
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

@CapacitorPlugin(name = "JeffSpike")
class JeffSpikePlugin : Plugin() {
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
        ContextCompat.startForegroundService(context, Intent(context, RelayForegroundService::class.java))
        call.resolve()
    }
}
