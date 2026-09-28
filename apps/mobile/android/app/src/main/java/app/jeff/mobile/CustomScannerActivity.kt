package app.jeff.mobile

import android.content.pm.PackageManager
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.widget.Button
import androidx.appcompat.app.AppCompatActivity
import com.google.zxing.BarcodeFormat
import com.google.zxing.DecodeHintType
import com.journeyapps.barcodescanner.CaptureManager
import com.journeyapps.barcodescanner.CompoundBarcodeView
import com.journeyapps.barcodescanner.DefaultDecoderFactory
import com.journeyapps.barcodescanner.camera.CameraSettings
import java.util.EnumMap

class CustomScannerActivity : AppCompatActivity() {
    private var capture: CaptureManager? = null
    private var barcodeScannerView: CompoundBarcodeView? = null
    private var isTorchOn = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_scanner)

        val scanner = findViewById<CompoundBarcodeView>(R.id.zxing_barcode_scanner)
        barcodeScannerView = scanner
        val settings = CameraSettings()
        settings.isAutoFocusEnabled = true
        settings.isContinuousFocusEnabled = true
        settings.isBarcodeSceneModeEnabled = true
        settings.focusMode = CameraSettings.FocusMode.CONTINUOUS
        scanner.cameraSettings = settings
        val hints = EnumMap<DecodeHintType, Any>(DecodeHintType::class.java)
        hints[DecodeHintType.TRY_HARDER] = true
        hints[DecodeHintType.CHARACTER_SET] = "UTF-8"
        // scanType=2：正片和反色都试。对着电脑屏幕时反光经常让默认解码器直接放弃。
        scanner.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE), hints, "UTF-8", 2)

        capture = CaptureManager(this, scanner)
        capture?.initializeFromIntent(intent, savedInstanceState)
        // initializeFromIntent 会按 Intent 盖掉解码器，这里再装回能扫屏幕的那一套。
        scanner.cameraSettings = settings
        scanner.decoderFactory = DefaultDecoderFactory(listOf(BarcodeFormat.QR_CODE), hints, "UTF-8", 2)
        capture?.decode()

        findViewById<View>(R.id.scanner_back_btn).setOnClickListener { finish() }

        val btnFlash = findViewById<Button>(R.id.scanner_flash_btn)
        if (!hasFlash()) {
            btnFlash.visibility = View.GONE
        } else {
            btnFlash.setOnClickListener {
                if (isTorchOn) {
                    scanner.setTorchOff()
                    isTorchOn = false
                    btnFlash.text = "打开手电"
                } else {
                    scanner.setTorchOn()
                    isTorchOn = true
                    btnFlash.text = "关闭手电"
                }
            }
        }
    }

    private fun hasFlash(): Boolean {
        return applicationContext.packageManager.hasSystemFeature(PackageManager.FEATURE_CAMERA_FLASH)
    }

    override fun onResume() {
        super.onResume()
        capture?.onResume()
    }

    override fun onPause() {
        super.onPause()
        capture?.onPause()
    }

    override fun onDestroy() {
        super.onDestroy()
        capture?.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        capture?.onSaveInstanceState(outState)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        capture?.onRequestPermissionsResult(requestCode, permissions, grantResults)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        return barcodeScannerView?.onKeyDown(keyCode, event) == true || super.onKeyDown(keyCode, event)
    }
}
