package app.jeff.mobile

import android.content.Context
import org.bouncycastle.crypto.agreement.X25519Agreement
import org.bouncycastle.crypto.params.X25519PrivateKeyParameters
import org.bouncycastle.crypto.params.X25519PublicKeyParameters
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * 用 Android 自带的 AES-GCM / HMAC，加上 BouncyCastle 的 X25519，重算
 * packages/core/tests/fixtures/remote-crypto-vectors.json。
 * 私钥与 packages/core/src/remote/crypto.ts 的 FIXTURE_PRIV 相同。
 */
object CryptoSelfTest {
    fun run(context: Context): String {
        val json = context.assets.open("remote-crypto-vectors.json").bufferedReader().use { it.readText() }
        val fx = JSONObject(json)
        val aliceStatic = ByteArray(32) { 0x11 }
        val aliceEph = ByteArray(32) { 0x22 }
        val bobStatic = ByteArray(32) { 0x33 }
        val bobEph = ByteArray(32) { 0x44 }
        checkHex("aliceStaticPub", pub(aliceStatic), fx)
        checkHex("aliceEphPub", pub(aliceEph), fx)
        checkHex("bobStaticPub", pub(bobStatic), fx)
        checkHex("bobEphPub", pub(bobEph), fx)

        val hs = handshake(aliceStatic, aliceEph, pub(bobStatic), pub(bobEph))
        if (hs.lowIsMe != fx.getBoolean("aliceIsLow")) error("aliceIsLow 不一致")
        checkHex("ikm", hs.ikm, fx)
        checkHex("lowToHigh", hs.lowToHigh, fx)
        checkHex("highToLow", hs.highToLow, fx)

        val plain = fx.getString("plaintext").toByteArray(Charsets.UTF_8)
        val c0 = seal(hs.sendKey, 0, plain)
        val c1 = seal(hs.sendKey, 1, plain)
        checkHex("ciphertext0", c0, fx)
        checkHex("ciphertext1", c1, fx)
        val back = NoteWatch.open(hs.sendKey, 0, c0)
        if (!back.contentEquals(plain)) error("ciphertext0 解不开")
        return "通过"
    }

    private fun checkHex(name: String, got: ByteArray, fx: JSONObject) {
        val hex = got.joinToString("") { "%02x".format(it) }
        if (hex != fx.getString(name)) error("$name 不一致")
    }

    private fun pub(priv: ByteArray): ByteArray = X25519PrivateKeyParameters(priv, 0).generatePublicKey().encoded

    private fun dh(priv: ByteArray, peerPub: ByteArray): ByteArray {
        val agree = X25519Agreement()
        agree.init(X25519PrivateKeyParameters(priv, 0))
        val out = ByteArray(32)
        agree.calculateAgreement(X25519PublicKeyParameters(peerPub, 0), out, 0)
        return out
    }

    private class Handshake(val lowIsMe: Boolean, val ikm: ByteArray, val lowToHigh: ByteArray, val highToLow: ByteArray, val sendKey: ByteArray)

    /** 与 crypto.ts handshake 同一顺序：公钥字节更小的一方是 low。 */
    private fun handshake(myStatic: ByteArray, myEph: ByteArray, peerStatic: ByteArray, peerEph: ByteArray): Handshake {
        val myStaticPub = pub(myStatic)
        val myEphPub = pub(myEph)
        val lowIsMe = compare(myStaticPub, peerStatic) < 0
        val staticLow = if (lowIsMe) myStaticPub else peerStatic
        val staticHigh = if (lowIsMe) peerStatic else myStaticPub
        val ephLow = if (lowIsMe) myEphPub else peerEph
        val ephHigh = if (lowIsMe) peerEph else myEphPub
        val ss1 = dh(myEph, peerEph)
        val ss2 = if (lowIsMe) dh(myEph, peerStatic) else dh(myStatic, peerEph)
        val ss3 = if (lowIsMe) dh(myStatic, peerEph) else dh(myEph, peerStatic)
        val ss4 = dh(myStatic, peerStatic)
        val ikm = ss1 + ss2 + ss3 + ss4
        val info = "jeff-remote-e2e-v1|".toByteArray(Charsets.UTF_8) + staticLow + staticHigh + ephLow + ephHigh
        val salt = "jeff-remote-e2e-v1".toByteArray(Charsets.UTF_8)
        val okm = hkdfSha256(ikm, salt, info, 64)
        val lowToHigh = okm.copyOfRange(0, 32)
        val highToLow = okm.copyOfRange(32, 64)
        val sendKey = if (lowIsMe) lowToHigh else highToLow
        return Handshake(lowIsMe, ikm, lowToHigh, highToLow, sendKey)
    }

    private fun seal(key: ByteArray, n: Int, plain: ByteArray): ByteArray {
        val nonce = ByteArray(12)
        var x = n.toLong()
        for (i in 11 downTo 4) {
            nonce[i] = (x and 0xff).toByte()
            x = x shr 8
        }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(128, nonce))
        cipher.updateAAD("jeff-frame-v1:$n".toByteArray(Charsets.UTF_8))
        return cipher.doFinal(plain)
    }

    private fun hkdfSha256(ikm: ByteArray, salt: ByteArray, info: ByteArray, length: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(salt, "HmacSHA256"))
        val prk = mac.doFinal(ikm)
        val okm = ByteArray(length)
        var prev = ByteArray(0)
        var pos = 0
        var counter = 1
        while (pos < length) {
            mac.init(SecretKeySpec(prk, "HmacSHA256"))
            mac.update(prev)
            mac.update(info)
            mac.update(counter.toByte())
            prev = mac.doFinal()
            val n = minOf(prev.size, length - pos)
            prev.copyInto(okm, pos, 0, n)
            pos += n
            counter++
        }
        return okm
    }

    private fun compare(a: ByteArray, b: ByteArray): Int {
        val n = minOf(a.size, b.size)
        for (i in 0 until n) {
            val d = (a[i].toInt() and 0xff) - (b[i].toInt() and 0xff)
            if (d != 0) return d
        }
        return a.size - b.size
    }
}
