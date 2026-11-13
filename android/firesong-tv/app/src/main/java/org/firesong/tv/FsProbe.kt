package org.firesong.tv

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.media.AudioManager
import android.os.Build
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import org.json.JSONObject

/**
 * `window.FSPROBE.info()` for the page: facts only the native side knows
 * (design §5). Read-only, no secrets. Exposed only while the WebView shows the
 * configured TV origin, because cross-origin navigations are blocked.
 */
class FsProbe(context: Context) {
    private val app = context.applicationContext

    @JavascriptInterface
    fun info(): String = collect(app).toString()

    companion object {
        const val JS_NAME = "FSPROBE"

        fun collect(ctx: Context): JSONObject {
            val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as AudioManager
            val pm = ctx.packageManager
            val am = ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
            val mem = ActivityManager.MemoryInfo().also { am.getMemoryInfo(it) }
            val dm = ctx.resources.displayMetrics
            val wv = WebView.getCurrentWebViewPackage()
            return JSONObject().apply {
                put("app", JSONObject().apply {
                    put("package", ctx.packageName)
                    put("versionName", BuildConfig.VERSION_NAME)
                    put("versionCode", BuildConfig.VERSION_CODE)
                    put("buildType", BuildConfig.BUILD_TYPE)
                })
                put("webview", JSONObject().apply {
                    put("package", wv?.packageName ?: JSONObject.NULL)
                    put("version", wv?.versionName ?: JSONObject.NULL)
                })
                put("device", JSONObject().apply {
                    put("manufacturer", Build.MANUFACTURER)
                    put("model", Build.MODEL)
                    put("device", Build.DEVICE)
                    put("android", Build.VERSION.RELEASE)
                    put("sdk", Build.VERSION.SDK_INT)
                    put("incremental", Build.VERSION.INCREMENTAL)
                })
                put("audio", JSONObject().apply {
                    put("outputFramesPerBuffer", audio.getProperty(AudioManager.PROPERTY_OUTPUT_FRAMES_PER_BUFFER) ?: JSONObject.NULL)
                    put("outputSampleRate", audio.getProperty(AudioManager.PROPERTY_OUTPUT_SAMPLE_RATE) ?: JSONObject.NULL)
                    put("featureLowLatency", pm.hasSystemFeature(PackageManager.FEATURE_AUDIO_LOW_LATENCY))
                    put("featurePro", pm.hasSystemFeature(PackageManager.FEATURE_AUDIO_PRO))
                })
                put("display", JSONObject().apply {
                    put("widthPx", dm.widthPixels)
                    put("heightPx", dm.heightPixels)
                    put("densityDpi", dm.densityDpi)
                    put("density", dm.density.toDouble())
                    // The HDMI mode can be larger than the UI (4K panel, 1080p UI).
                    @Suppress("DEPRECATION")
                    val mode = (ctx.getSystemService(Context.WINDOW_SERVICE) as WindowManager).defaultDisplay.mode
                    put("modePx", "${mode.physicalWidth}x${mode.physicalHeight}@${mode.refreshRate}")
                })
                put("memory", JSONObject().apply {
                    put("availMB", mem.availMem / (1024 * 1024))
                    put("totalMB", mem.totalMem / (1024 * 1024))
                    put("thresholdMB", mem.threshold / (1024 * 1024))
                    put("lowMemory", mem.lowMemory)
                    put("memoryClassMB", am.memoryClass)
                })
            }
        }
    }
}
