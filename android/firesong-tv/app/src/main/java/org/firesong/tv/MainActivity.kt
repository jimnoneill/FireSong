package org.firesong.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Color
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.http.SslCertificate
import android.net.http.SslError
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.Gravity
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.RenderProcessGoneDetail
import android.webkit.SslErrorHandler
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * FireSong on the Fire TV: one fullscreen WebView showing the TV page of the
 * FireSong server (design §5). Everything the page needs from the host lives
 * here: settings, the host-token cookie, remote keys, crash and network
 * recovery, console logging and the FSPROBE bridge.
 *
 * Configuration comes only through the `org.firesong.tv/.Configure` alias,
 * which requires WRITE_SECURE_SETTINGS (held by `adb shell`, not by apps):
 *
 *   adb shell am start -n org.firesong.tv/.Configure \
 *       --es url https://<tv-host>:64443/?tv=1 --es host_token <token>
 */
class MainActivity : Activity() {
    companion object {
        const val TAG = "FireSong"
        const val JS_TAG = "FireSongJS"
        private const val CONFIGURE_ALIAS = "org.firesong.tv.Configure"
        private const val COOKIE_NAME = "firesong_host"
        private const val CRASH_WINDOW_MS = 60_000L
        private const val CRASH_LIMIT = 3
        private const val WATCHDOG_MS = 5_000L
        private const val WATCHDOG_FAILS = 3
    }

    private enum class Overlay { NONE, LOADING, RECONNECTING, NOT_CONFIGURED, CRASHED }

    private lateinit var root: FrameLayout
    private lateinit var overlay: View
    private lateinit var overlayArt: ImageView
    private lateinit var overlayContent: LinearLayout
    private lateinit var overlayMark: View
    private lateinit var overlayTitle: TextView
    private lateinit var overlayDetail: TextView
    private var overlayState = Overlay.NONE

    private var webView: WebView? = null
    private val handler = Handler(Looper.getMainLooper())
    private val backoff = Backoff()
    private val backTracker = BackKeyTracker()
    private val page = PageLifecycle()
    private var loads = 0
    private var settings = TvSettings()
    private var targetUrl: String? = null
    private var mainFrameFailed = false
    private var pageLoaded = false
    private var retryScheduled = false
    private val crashTimes = ArrayDeque<Long>()
    private var exitDialog: AlertDialog? = null
    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var audioFocusRequest: AudioFocusRequest? = null

    private val watchdogExecutor: ExecutorService = Executors.newSingleThreadExecutor()
    private var watchdogRunning = false
    private var watchdogFails = 0
    private var outage = false

    private val retryRunnable = Runnable {
        retryScheduled = false
        loadTarget("retry #${backoff.attempt}")
    }

    private val watchdogTick: Runnable = object : Runnable {
        override fun run() {
            val url = targetUrl
            if (watchdogRunning && url != null && pageLoaded && !retryScheduled) {
                watchdogExecutor.execute {
                    val up = ServerProbe.isUp(url)
                    handler.post { onWatchdogResult(url, up) }
                }
            }
            if (watchdogRunning) handler.postDelayed(this, WATCHDOG_MS)
        }
    }

    // ---- lifecycle -----------------------------------------------------------

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        volumeControlStream = AudioManager.STREAM_MUSIC
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        overlay = findViewById(R.id.overlay)
        overlayArt = findViewById(R.id.overlay_art)
        overlayContent = findViewById(R.id.overlay_content)
        overlayMark = findViewById(R.id.overlay_mark)
        overlayTitle = findViewById(R.id.overlay_title)
        overlayDetail = findViewById(R.id.overlay_detail)

        settings = Prefs.load(this)
        // A recreated activity gets the intent that first started it again;
        // newer settings arrived later through onNewIntent and are in Prefs.
        if (savedInstanceState == null) applyConfigureIntent(intent)
        Log.i(TAG, "start: ${BuildConfig.VERSION_NAME} (${BuildConfig.BUILD_TYPE}), " +
            "webview=${WebView.getCurrentWebViewPackage()?.let { "${it.packageName} ${it.versionName}" }}, " +
            "density=${resources.displayMetrics.densityDpi}")

        WebView.setWebContentsDebuggingEnabled(devtoolsEnabled())
        registerNetworkCallback()
    }

    override fun onStart() {
        super.onStart()
        if (page.onStart() == PageLifecycle.Action.BUILD_AND_LOAD) {
            createWebView()
            loadTarget(if (loads++ == 0) "start" else "back in front")
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        // A plain launcher start while running keeps the page as it is.
        if (applyConfigureIntent(intent)) {
            WebView.setWebContentsDebuggingEnabled(devtoolsEnabled())
            loadTarget("configure")
        }
    }

    override fun onResume() {
        super.onResume()
        webView?.onResume()
        requestAudioFocus()
        startWatchdog()
    }

    override fun onPause() {
        stopWatchdog()
        webView?.onPause()
        super.onPause()
    }

    override fun onStop() {
        abandonAudioFocus()
        if (page.onStop(isChangingConfigurations) == PageLifecycle.Action.TEAR_DOWN) {
            closePage()
        }
        super.onStop()
    }

    /** Ends the page while FireSong is not in front: no song, voices or TV seat in the background. */
    private fun closePage() {
        handler.removeCallbacks(retryRunnable)
        retryScheduled = false
        pageLoaded = false
        exitDialog?.dismiss()
        destroyWebView()
        Log.i(TAG, "not in front: page closed; it reloads when FireSong is opened again")
    }

    override fun onDestroy() {
        stopWatchdog()
        watchdogExecutor.shutdownNow()
        handler.removeCallbacksAndMessages(null)
        unregisterNetworkCallback()
        exitDialog?.dismiss()
        destroyWebView()
        super.onDestroy()
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        Log.w(TAG, "onTrimMemory level=$level")
    }

    // ---- configuration -------------------------------------------------------

    private fun devtoolsEnabled(): Boolean = settings.devtools ?: BuildConfig.DEBUG

    private fun readExtras(intent: Intent): ConfigExtras? {
        val b = intent.extras ?: return null
        val keys = setOf("url", "host_token", "leaf_pin", "devtools", "clear", "reload")
        if (b.keySet().none { it in keys }) return null
        @Suppress("DEPRECATION")
        val devtools = when (val v = b.get("devtools")) {
            is Boolean -> v
            is String -> v.trim().equals("true", ignoreCase = true) || v.trim() == "1"
            else -> null
        }
        return ConfigExtras(
            url = b.getString("url"),
            hostToken = b.getString("host_token"),
            leafPin = b.getString("leaf_pin"),
            devtools = devtools,
            clear = b.getBoolean("clear", false),
            issuedMs = when (val v = b.get("issued_ms")) {
                is Long -> v
                is Int -> v.toLong()
                is String -> v.trim().toLongOrNull()
                else -> null
            },
        )
    }

    /** Applies a `.Configure` intent; true when the page should (re)load. */
    private fun applyConfigureIntent(intent: Intent?): Boolean {
        intent ?: return false
        val extras = readExtras(intent) ?: return false
        // Consume the extras for this process; across a process death the
        // savedInstanceState check in onCreate and issued_ms (TvConfig.apply) do it.
        intent.replaceExtras(Bundle())
        if (intent.component?.className != CONFIGURE_ALIAS) {
            Log.w(TAG, "configuration extras ignored: send them to org.firesong.tv/.Configure (adb shell only)")
            return false
        }
        return when (val r = TvConfig.apply(settings, extras, BuildConfig.DEFAULT_TV_URL, BuildConfig.ALLOW_CLEARTEXT)) {
            is ConfigResult.Rejected -> {
                Log.e(TAG, "configure: ${r.reason}")
                false
            }
            ConfigResult.Superseded -> {
                Log.i(TAG, "configure: an older intent; keeping the newer settings")
                false
            }
            is ConfigResult.Ok -> {
                settings = r.settings
                Prefs.save(this, settings)
                r.notes.forEach { Log.i(TAG, "configure: $it") }
                if (r.notes.isEmpty()) Log.i(TAG, "configure: reload")
                true
            }
        }
    }

    // ---- WebView -------------------------------------------------------------

    // JavaScript is the point: the page is the FireSong client, and navigation
    // is held to the configured origin (shouldOverrideUrlLoading).
    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView() {
        val wv = WebView(this)
        wv.setBackgroundColor(Color.BLACK)
        wv.isFocusable = true
        wv.isFocusableInTouchMode = true
        wv.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            allowFileAccess = false
            allowContentAccess = false
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
            setSupportMultipleWindows(false)
            javaScriptCanOpenWindowsAutomatically = false
            userAgentString = "$userAgentString FireSongTV/${BuildConfig.VERSION_NAME}"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(wv, false)
        // Keep the renderer at foreground priority while visible (the Cube has 2 GB).
        wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, true)
        wv.addJavascriptInterface(FsProbe(this), FsProbe.JS_NAME)
        wv.webViewClient = Client()
        wv.webChromeClient = Chrome()
        root.addView(wv, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        webView = wv
    }

    private fun destroyWebView() {
        val wv = webView ?: return
        webView = null
        root.removeView(wv)
        wv.stopLoading()
        wv.webChromeClient = null
        wv.destroy()
    }

    private fun loadTarget(reason: String) {
        handler.removeCallbacks(retryRunnable)
        retryScheduled = false
        outage = false
        watchdogFails = 0
        pageLoaded = false
        val url = TvConfig.effectiveUrl(settings, BuildConfig.DEFAULT_TV_URL, BuildConfig.ALLOW_CLEARTEXT)
        targetUrl = url
        if (url == null) {
            showOverlay(Overlay.NOT_CONFIGURED, getString(R.string.not_configured_detail))
            Log.w(TAG, "no TV URL configured")
            return
        }
        val wv = webView ?: return
        if (overlayState == Overlay.NONE || overlayState == Overlay.NOT_CONFIGURED) {
            showOverlay(Overlay.LOADING, getString(R.string.overlay_loading_detail, UrlPolicy.origin(url)))
        }
        Log.i(TAG, "load ${UrlPolicy.origin(url)} ($reason)")
        val token = TvConfig.tokenFor(settings, url)
        if (token == null) {
            wv.loadUrl(url)
            return
        }
        val cookie = buildString {
            append("$COOKIE_NAME=$token; Path=/; HttpOnly; SameSite=Strict")
            if (UrlPolicy.isHttps(url)) append("; Secure")
        }
        val cm = CookieManager.getInstance()
        cm.setCookie(UrlPolicy.origin(url), cookie) { ok ->
            if (!ok) Log.w(TAG, "host cookie was not stored")
            cm.flush()
            if (webView === wv && targetUrl == url) wv.loadUrl(url)
        }
    }

    private fun scheduleRetry(reason: String) {
        if (retryScheduled) return
        pageLoaded = false
        val delay = backoff.nextDelayMs()
        Log.w(TAG, "main frame failed: $reason; retry #${backoff.attempt} in $delay ms")
        showOverlay(Overlay.RECONNECTING, getString(R.string.overlay_reconnecting_detail, reason, delay / 1000))
        retryScheduled = true
        handler.postDelayed(retryRunnable, delay)
    }

    private fun onRendererGone(detail: RenderProcessGoneDetail) {
        Log.e(TAG, "renderer gone: crashed=${detail.didCrash()} priorityAtExit=${detail.rendererPriorityAtExit()}")
        val now = SystemClock.elapsedRealtime()
        crashTimes.addLast(now)
        while (crashTimes.isNotEmpty() && now - crashTimes.first() > CRASH_WINDOW_MS) crashTimes.removeFirst()
        destroyWebView()
        when (page.onRendererGone(crashTimes.size, CRASH_LIMIT)) {
            PageLifecycle.Action.REBUILD_AND_RETRY -> {
                createWebView()
                showOverlay(Overlay.CRASHED, getString(R.string.overlay_crashed_detail))
                scheduleRetry("renderer lost ${crashTimes.size}x in 60 s")
            }
            PageLifecycle.Action.REBUILD_AND_LOAD -> {
                createWebView()
                showOverlay(Overlay.LOADING, getString(R.string.overlay_restarting_detail))
                loadTarget("renderer restart")
            }
            PageLifecycle.Action.TEAR_DOWN -> Log.i(TAG, "renderer lost while not in front: page reloads on return")
            PageLifecycle.Action.NONE, PageLifecycle.Action.BUILD_AND_LOAD -> Unit
        }
    }

    private fun onWatchdogResult(url: String, up: Boolean) {
        if (url != targetUrl) return
        if (up) {
            watchdogFails = 0
            if (outage) {
                Log.i(TAG, "server reachable again: reloading")
                backoff.reset()
                loadTarget("server back")
            }
            return
        }
        watchdogFails++
        if (!outage && pageLoaded && watchdogFails >= WATCHDOG_FAILS) {
            outage = true
            Log.w(TAG, "server unreachable for ${watchdogFails} checks")
            showOverlay(Overlay.RECONNECTING, getString(R.string.overlay_lost_detail))
        }
    }

    private fun startWatchdog() {
        if (watchdogRunning) return
        watchdogRunning = true
        handler.postDelayed(watchdogTick, WATCHDOG_MS)
    }

    private fun stopWatchdog() {
        watchdogRunning = false
        handler.removeCallbacks(watchdogTick)
    }

    // ---- overlay ------------------------------------------------------------

    private fun showOverlay(state: Overlay, detail: String) {
        overlayState = state
        overlayTitle.setText(
            when (state) {
                Overlay.LOADING, Overlay.NONE -> R.string.overlay_loading
                Overlay.RECONNECTING -> R.string.overlay_reconnecting
                Overlay.NOT_CONFIGURED -> R.string.overlay_not_configured
                Overlay.CRASHED -> R.string.overlay_crashed
            },
        )
        overlayDetail.text = detail
        // The connecting art carries the logo and "Connecting…" itself; the other
        // states put the mascot and their message on the stage backdrop.
        val connecting = state == Overlay.LOADING || state == Overlay.NONE
        overlayArt.setImageResource(if (connecting) R.drawable.tv_connecting else R.drawable.stage_backdrop)
        overlayArt.contentDescription = if (connecting) getString(R.string.overlay_connecting) else null
        overlayMark.visibility = if (connecting) View.GONE else View.VISIBLE
        overlayTitle.visibility = if (connecting) View.GONE else View.VISIBLE
        overlayContent.gravity = if (connecting) Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL else Gravity.CENTER
        overlay.visibility = View.VISIBLE
    }

    private fun hideOverlay() {
        overlayState = Overlay.NONE
        overlay.visibility = View.GONE
    }

    // ---- keys ---------------------------------------------------------------

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val code = event.keyCode
        if (code == KeyEvent.KEYCODE_BACK) {
            handleBack(event)
            return true
        }
        val wv = webView
        if (wv != null && overlayState == Overlay.NONE && KeyBridge.isTranslated(code)) {
            wv.dispatchKeyEvent(
                KeyEvent(
                    event.downTime, event.eventTime, event.action, KeyBridge.translate(code),
                    event.repeatCount, event.metaState, event.deviceId, 0, event.flags, event.source,
                ),
            )
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    private fun handleBack(event: KeyEvent) {
        val action = when (event.action) {
            KeyEvent.ACTION_DOWN -> backTracker.onDown(event.eventTime, event.repeatCount, event.isLongPress)
            KeyEvent.ACTION_UP -> backTracker.onUp(event.eventTime)
            else -> BackKeyTracker.Action.NONE
        }
        when (action) {
            BackKeyTracker.Action.SHOW_EXIT -> showExitPrompt()
            BackKeyTracker.Action.SEND_ESCAPE -> {
                val wv = webView
                // Without a page there is nothing to go back in: offer to exit.
                if (wv == null || overlayState != Overlay.NONE) showExitPrompt() else sendEscape(wv, event)
            }
            BackKeyTracker.Action.NONE -> Unit
        }
    }

    private fun sendEscape(wv: WebView, src: KeyEvent) {
        val now = SystemClock.uptimeMillis()
        for (a in intArrayOf(KeyEvent.ACTION_DOWN, KeyEvent.ACTION_UP)) {
            wv.dispatchKeyEvent(KeyEvent(now, now, a, KeyBridge.BACK_TARGET, 0, 0, src.deviceId, 0, 0, src.source))
        }
    }

    private fun showExitPrompt() {
        if (exitDialog?.isShowing == true) return
        backTracker.reset()
        val dialog = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)
            .setTitle(R.string.exit_title)
            .setMessage(R.string.exit_message)
            .setPositiveButton(R.string.exit_yes) { _, _ -> finish() }
            .setNegativeButton(R.string.exit_no, null)
            .create()
        dialog.setOnShowListener { dialog.getButton(AlertDialog.BUTTON_NEGATIVE)?.requestFocus() }
        dialog.show()
        exitDialog = dialog
        Log.i(TAG, "exit prompt shown")
    }

    // ---- audio focus and network ----------------------------------------------

    private fun requestAudioFocus() {
        val am = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        val req = audioFocusRequest ?: AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setAudioAttributes(
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build(),
            )
            .setOnAudioFocusChangeListener { Log.i(TAG, "audio focus change: $it") }
            .build()
        audioFocusRequest = req
        Log.i(TAG, "audio focus request: ${am.requestAudioFocus(req)}")
    }

    private fun abandonAudioFocus() {
        val req = audioFocusRequest ?: return
        (getSystemService(Context.AUDIO_SERVICE) as AudioManager).abandonAudioFocusRequest(req)
    }

    private fun registerNetworkCallback() {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                handler.post {
                    if (retryScheduled) {
                        Log.i(TAG, "network available: retrying now")
                        loadTarget("network up")
                    }
                }
            }

            override fun onLost(network: Network) {
                Log.w(TAG, "network lost")
            }
        }
        try {
            cm.registerDefaultNetworkCallback(cb)
            networkCallback = cb
        } catch (e: RuntimeException) {
            Log.w(TAG, "network callback unavailable: $e")
        }
    }

    private fun unregisterNetworkCallback() {
        val cb = networkCallback ?: return
        networkCallback = null
        try {
            (getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager).unregisterNetworkCallback(cb)
        } catch (e: RuntimeException) {
            Log.w(TAG, "unregister network callback: $e")
        }
    }

    // ---- clients --------------------------------------------------------------

    private inner class Client : WebViewClient() {
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            if (!request.isForMainFrame) return false
            val url = request.url.toString()
            if (url == "about:blank" || UrlPolicy.sameOrigin(url, targetUrl)) return false
            Log.w(TAG, "blocked navigation to ${UrlPolicy.origin(url) ?: request.url.scheme}")
            return true
        }

        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
            if (view === webView) mainFrameFailed = false
        }

        override fun onPageFinished(view: WebView, url: String?) {
            if (view !== webView || mainFrameFailed) return
            if (url == null || !UrlPolicy.sameOrigin(url, targetUrl)) return
            pageLoaded = true
            backoff.reset()
            hideOverlay()
            view.requestFocus()
            Log.i(TAG, "page ready: ${UrlPolicy.origin(url)}")
        }

        override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
            if (view !== webView || !request.isForMainFrame) return
            mainFrameFailed = true
            scheduleRetry("network error ${error.errorCode} (${error.description})")
        }

        override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) {
            if (view !== webView || !request.isForMainFrame) return
            val code = response.statusCode
            if (code == 401) {
                mainFrameFailed = true
                scheduleRetry(getString(R.string.reason_token))
            } else if (code >= 500) {
                mainFrameFailed = true
                scheduleRetry("server error $code")
            }
        }

        // Proceeds only for the TV host with a pinned leaf (design §4); see CertPin.
        @SuppressLint("WebViewClientOnReceivedSslError")
        override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) {
            val der = SslCertificate.saveState(error.certificate)?.getByteArray("x509-certificate")
            val tv = targetUrl
            val pins = TvConfig.parsePins(BuildConfig.LEAF_PINS) + (tv?.let { TvConfig.pinsFor(settings, it) } ?: emptyList())
            if (CertPin.shouldProceed(error.url, tv, der, pins)) {
                Log.w(TAG, "TLS error ${error.primaryError} for ${UrlPolicy.origin(error.url)}: leaf pin matched, proceeding")
                handler.proceed()
                return
            }
            Log.e(
                TAG,
                "TLS error ${error.primaryError} for ${UrlPolicy.origin(error.url)}: cancelled " +
                    "(leaf sha256=${der?.let(CertPin::certSha256Hex)}, spki=${der?.let(CertPin::parse)?.let(CertPin::spkiPin)})",
            )
            handler.cancel()
            if (view === webView && UrlPolicy.sameOrigin(error.url, tv) && !pageLoaded) {
                mainFrameFailed = true
                scheduleRetry(getString(R.string.reason_tls))
            }
        }

        override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
            if (view === webView) {
                onRendererGone(detail)
            } else {
                Log.w(TAG, "an old renderer went away")
            }
            return true
        }
    }

    private inner class Chrome : WebChromeClient() {
        override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
            val priority = when (msg.messageLevel()) {
                ConsoleMessage.MessageLevel.ERROR -> Log.ERROR
                ConsoleMessage.MessageLevel.WARNING -> Log.WARN
                ConsoleMessage.MessageLevel.DEBUG, ConsoleMessage.MessageLevel.TIP -> Log.DEBUG
                else -> Log.INFO
            }
            val src = msg.sourceId()?.substringAfterLast('/')?.substringBefore('?').orEmpty()
            Log.println(priority, JS_TAG, "${msg.message()} [$src:${msg.lineNumber()}]")
            return true
        }

        override fun onPermissionRequest(request: PermissionRequest) {
            // The TV never captures: no RECORD_AUDIO/CAMERA in the manifest. Grant
            // only what the app itself holds, and only to the TV origin.
            val sameOrigin = UrlPolicy.sameOrigin(request.origin.toString(), targetUrl)
            val grantable = request.resources.filter { res ->
                sameOrigin && when (res) {
                    PermissionRequest.RESOURCE_AUDIO_CAPTURE -> holds(android.Manifest.permission.RECORD_AUDIO)
                    PermissionRequest.RESOURCE_VIDEO_CAPTURE -> holds(android.Manifest.permission.CAMERA)
                    else -> false
                }
            }
            Log.i(TAG, "permission request ${request.resources.joinToString()} from ${request.origin}: granted ${grantable.joinToString()}")
            if (grantable.isEmpty()) request.deny() else request.grant(grantable.toTypedArray())
        }

        override fun getDefaultVideoPoster(): Bitmap =
            // No grey play-button poster on the TV before a clip starts.
            Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888)
    }

    private fun holds(permission: String): Boolean =
        checkSelfPermission(permission) == android.content.pm.PackageManager.PERMISSION_GRANTED
}
