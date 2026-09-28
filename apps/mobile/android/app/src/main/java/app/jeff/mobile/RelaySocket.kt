package app.jeff.mobile

import android.annotation.SuppressLint
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.security.SecureRandom
import java.security.cert.CertificateException
import java.security.cert.X509Certificate
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import javax.net.ssl.X509TrustManager
import java.security.MessageDigest

/** 前台服务持有的出站连接。页面被冻住时套接字还在。 */
object RelaySocket {
    var onText: ((String) -> Unit)? = null
    var onClosed: ((String) -> Unit)? = null
    private var socket: WebSocket? = null

    @SuppressLint("CustomX509TrustManager")
    fun open(url: String, pin: String) {
        close()
        val builder = OkHttpClient.Builder().readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS)
        if (url.startsWith("wss://")) {
            val trust = object : X509TrustManager {
                override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
                override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {
                    val cert = chain?.firstOrNull() ?: throw CertificateException("没有证书")
                    val digest = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
                    val fp = digest.joinToString(":") { "%02X".format(it) }
                    if (!pin.equals(fp, ignoreCase = true)) throw CertificateException("证书指纹不符")
                }
                override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
            }
            val ctx = SSLContext.getInstance("TLS")
            ctx.init(null, arrayOf(trust), SecureRandom())
            builder.sslSocketFactory(ctx.socketFactory, trust)
            builder.hostnameVerifier { _, _ -> true }
        }
        socket = builder.build().newWebSocket(Request.Builder().url(url).build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                if (webSocket !== socket) return
                onText?.invoke(text)
            }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (webSocket !== socket) return
                onClosed?.invoke(reason)
            }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (webSocket !== socket) return
                onClosed?.invoke(t.message ?: "连接失败")
            }
        })
    }

    fun send(text: String) {
        if (socket?.send(text) != true) error("还没连上中转站")
    }

    fun close() {
        socket?.close(1000, "bye")
        socket = null
    }
}
