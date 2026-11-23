package org.firesong.tv

import android.content.Context
import android.os.SystemClock
import android.util.Log
import java.util.TreeMap
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.ScheduledThreadPoolExecutor
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import org.webrtc.PeerConnectionFactory
import org.webrtc.audio.AudioProcessingState
import org.webrtc.audio.JavaAudioDeviceModule

/** One per process: the fs-mics FIFO executor and the PeerConnectionFactory (created on first hello, never disposed). */
object MicEngine {
    private const val TAG = "FireSong"
    private const val STATUS_MS = 250L
    private const val ENGINE_STATS_MS = 1000L
    private const val PEER_STATS_MS = 2000L
    private const val MONITOR_POLL_MS = 50L

    /** A backstop only: the engine reports `no-tone` itself, 2.2 s after the beep plays (about 2.7 s in). */
    private const val MONITOR_LIMIT_MS = 4000L
    private const val CLOSE_INTERNAL_ERROR = 1011
    private const val ECHO_DELAY_MS = 120.0
    private const val ECHO_MAX_DELAY_MS = 220.0
    private const val DEFAULT_ECHO_WET = 0.36
    private const val GATE_THRESHOLD = 0.001
    private const val PEAK_FULL_SCALE = 32768.0

    /**
     * The network monitor lists networks from ConnectivityManager when it starts. By default it reads its
     * callback cache, still empty at that moment, so a connection opened while no other was open gathered on
     * no network and answered without a candidate.
     */
    private const val FIELD_TRIALS = "WebRTC-NetworkMonitorAutoDetect/getAllNetworksFromCache:false/"

    /** States of [NativeMics.monitorResult]. */
    private const val MONITOR_DONE = 1
    private const val MONITOR_FAILED = 2

    /** Indices of [NativeMics.slotStatus]. */
    private const val STATUS_LEVEL_RMS = 0
    private const val STATUS_GATE_OPEN = 1
    private const val STATUS_FEEDBACK_HZ = 2
    private const val STATUS_BOOST_DB = 3
    private const val STATUS_FILL_MS = 4
    private const val STATUS_OUT_RMS = 5
    private const val STATUS_ATTACHED = 6

    /** Indices of [NativeMics.engineStats]. */
    private const val STATS_OPEN = 0
    private const val STATS_OUTPUT_LATENCY_US = 1
    private const val STATS_BURST_FRAMES = 2
    private const val STATS_BUFFER_FRAMES = 3
    private const val STATS_XRUNS = 4
    private const val STATS_RESTARTS = 5
    private const val STATS_CALLBACK_P99_US = 6
    private const val STATS_CALLBACK_MAX_US = 7
    private const val STATS_PUSH_INTERVAL_P50_US = 8
    private const val STATS_PUSH_INTERVAL_P99_US = 9
    private const val STATS_PUSH_INTERVAL_MAX_US = 10
    private const val STATS_PUSH_TO_PRESENT_P50_US = 11
    private const val STATS_PUSH_TO_PRESENT_P95_US = 12
    private const val STATS_TAP_DROPPED = 13
    private const val STATS_PEAK_Q15 = 14
    private const val STATS_TAP_DRAIN_P99_US = 16
    private const val STATS_TAP_DRAIN_MAX_US = 17
    private const val STATS_OPEN_ATTEMPTS = 18
    private const val STATS_SLOT_BASE = 24
    private const val STATS_SLOT_STRIDE = 4

    private val executor = ScheduledThreadPoolExecutor(1) { runnable ->
        Thread(runnable, "fs-mics").apply { isDaemon = true }
    }.apply { removeOnCancelPolicy = true }

    private val sessionNumbers = AtomicInteger()

    // fs-mics only.
    private var initialized = false
    private var factory: PeerConnectionFactory? = null
    private var apm: String? = null
    private var lastGen = 0
    private var currentToken = 0

    /** A handler for one door connection. Its messages and its teardown run on fs-mics in arrival order. */
    fun session(context: Context, channel: PageChannel): PageHandler =
        Session(context.applicationContext, channel, sessionNumbers.incrementAndGet())

    /** The process's factory, created on first use; null when libwebrtc cannot start. */
    private fun factory(context: Context): PeerConnectionFactory? {
        factory?.let { return it }
        return try {
            if (!initialized) {
                PeerConnectionFactory.initialize(
                    PeerConnectionFactory.InitializationOptions.builder(context).createInitializationOptions(),
                )
                initialized = true
            }
            val adm = JavaAudioDeviceModule.builder(context)
                .setUseStereoOutput(false)
                .setUseHardwareAcousticEchoCanceler(false)
                .setUseHardwareNoiseSuppressor(false)
                .createAudioDeviceModule()
            val created = try {
                PeerConnectionFactory.builder()
                    .setFieldTrials(FIELD_TRIALS)
                    .setAudioDeviceModule(adm)
                    .createPeerConnectionFactory()
            } finally {
                adm.release()
            }
            apm = runCatching { describe(created.audioProcessingState) }.getOrNull()
            Log.i(TAG, "webrtc factory ready, apm ${apm ?: "unknown"}")
            factory = created
            created
        } catch (e: Throwable) {
            Log.e(TAG, "webrtc factory failed: ${e.javaClass.name}")
            null
        }
    }

    /** `none`, or each audio processing component with its effective implementation. */
    private fun describe(state: AudioProcessingState): String {
        if (!state.hasAudioProcessingModule) return "none"
        return listOf(
            "ec" to state.echoCancellation,
            "ns" to state.noiseSuppression,
            "agc" to state.autoGainControl,
            "hpf" to state.highPassFilter,
        ).joinToString(",") { (name, component) -> "$name:${component.effective}" }
    }

    private class SlotState {
        var monitored = false
        var muted = false
        var volume = 1.0
        var echo = 1.0
        var gen = 0
        var jitterMs: Double? = null
        var calibration: Calibration? = null
    }

    /** A monitor-beep result and the terms it is corrected by as they move (design §3.1.4 `monitorMs`). */
    private class Calibration(val ms: Double, val jitterMs: Double?, val fillMs: Double, val outputMs: Double?)

    private enum class State { NEW, READY, REFUSED, CLOSED }

    private class Session(
        private val context: Context,
        override val channel: PageChannel,
        private val number: Int,
    ) : PageHandler, PeerHost {
        private val ended = AtomicBoolean(false)
        private val ignored = AtomicLong()

        // fs-mics only.
        private var state = State.NEW
        private var token = 0
        private val peers = HashMap<Int, MicPeer>()
        private val slots = TreeMap<Int, SlotState>()
        private val timers = ArrayList<ScheduledFuture<*>>()
        private val status = FloatArray(NativeMics.STATUS_LEN)
        private var echoWet = DEFAULT_ECHO_WET
        private var outputLatencyMs: Double? = null

        override fun onMessage(message: PageMessage) = post { handle(message) }

        override fun onIgnored() {
            ignored.incrementAndGet()
        }

        override fun onClosed() {
            if (ended.compareAndSet(false, true)) post { teardown() }
        }

        override fun send(message: AppMessage) {
            if (state != State.CLOSED) channel.send(message)
        }

        override fun post(task: () -> Unit) = executor.execute(guarded(task))

        override fun schedule(delayMs: Long, task: () -> Unit): ScheduledFuture<*> =
            executor.schedule(guarded(task), delayMs, TimeUnit.MILLISECONDS)

        override fun nextGen(): Int = ++lastGen

        override fun attached(peer: MicPeer) {
            slot(peer.slot).apply {
                gen = peer.gen
                jitterMs = peer.jitterMs
            }
        }

        override fun statsUpdated(peer: MicPeer) {
            val slot = slots[peer.slot] ?: return
            if (slot.gen == peer.gen) slot.jitterMs = peer.jitterMs
        }

        override fun dropped(peer: MicPeer) {
            if (peers[peer.id] === peer) peers.remove(peer.id)
        }

        private fun guarded(task: () -> Unit) = Runnable {
            try {
                task()
            } catch (e: Throwable) {
                fail(e)
            }
        }

        private fun fail(e: Throwable) {
            Log.e(TAG, "mics session $number: ${e.javaClass.name} at ${e.stackTrace.firstOrNull()}")
            if (state == State.CLOSED) return
            send(AppMessage.Fatal(FatalReason.INTERNAL))
            channel.close(CLOSE_INTERNAL_ERROR)
            try {
                teardown()
            } catch (again: Throwable) {
                Log.e(TAG, "mics session $number teardown: ${again.javaClass.name}")
            }
        }

        private fun handle(message: PageMessage) {
            when {
                state == State.CLOSED -> Unit
                message is PageMessage.Hello -> hello()
                state == State.READY -> control(message)
                else -> ignored.incrementAndGet()
            }
        }

        private fun hello() {
            if (state != State.NEW) {
                ignored.incrementAndGet()
                return
            }
            if (!NativeMics.available) return refuse(ReadyFailReason.LIB)
            factory(context) ?: return refuse(ReadyFailReason.WEBRTC)
            val started = NativeMics.start()
            if (started <= 0) return refuse(ReadyFailReason.LIB)
            token = started
            currentToken = started
            state = State.READY

            val stats = LongArray(NativeMics.STATS_LEN).also { NativeMics.engineStats(it) }
            val open = stats[STATS_OPEN] != 0L
            outputLatencyMs = latencyMs(stats)
            send(
                AppMessage.ReadyOk(
                    features = listOf(FEATURE_MICS),
                    audio = if (open) ReadyAudio.OPEN else ReadyAudio.PENDING,
                    rate = NativeMics.RATE,
                    burstFrames = stats[STATS_BURST_FRAMES].takeIf { open && it > 0 }?.toInt(),
                    outputLatencyMs = outputLatencyMs.takeIf { open },
                ),
            )
            timers += every(STATUS_MS) { sendStatus() }
            timers += every(ENGINE_STATS_MS) { sendEngineStats() }
            timers += every(PEER_STATS_MS) { peers.values.toList().forEach { it.requestStats() } }
            Log.i(TAG, "mics session $number ready, token $token, audio ${if (open) "open" else "pending"}")
        }

        private fun refuse(reason: ReadyFailReason) {
            state = State.REFUSED
            Log.w(TAG, "mics session $number refused: ${reason.wire}")
            send(AppMessage.ReadyFailed(reason))
        }

        private fun every(periodMs: Long, task: () -> Unit): ScheduledFuture<*> = executor.scheduleWithFixedDelay(
            guarded { if (state == State.READY) task() },
            periodMs,
            periodMs,
            TimeUnit.MILLISECONDS,
        )

        private fun control(message: PageMessage) {
            when (message) {
                is PageMessage.Hello -> ignored.incrementAndGet()
                is PageMessage.Offer -> offer(message)
                is PageMessage.Ice -> {
                    val peer = peers[message.peer] ?: return ignore()
                    val candidate = message.candidate ?: return
                    if (SdpFilter.candidateAllowed(candidate.candidate)) peer.addIce(candidate) else ignore()
                }
                is PageMessage.Close -> peers.remove(message.peer)?.close() ?: ignore()
                is PageMessage.Detach -> slots[message.slot]?.gen?.takeIf { it != 0 }?.let { gen ->
                    NativeMics.detach(message.slot, gen)
                    channel.wakeTap()
                }
                is PageMessage.Release -> {
                    NativeMics.release(message.slot)
                    slots.remove(message.slot)
                }
                is PageMessage.Monitor -> if (message.on || message.slot in slots) {
                    slot(message.slot).monitored = message.on
                    NativeMics.set(message.slot, NativeMics.MONITOR, flag(message.on))
                }
                is PageMessage.Mute -> {
                    slot(message.slot).muted = message.muted
                    NativeMics.set(message.slot, NativeMics.MUTED, flag(message.muted))
                }
                is PageMessage.Mix -> {
                    slot(message.slot).apply {
                        volume = message.volume
                        echo = message.echo
                    }
                    NativeMics.set(message.slot, NativeMics.VOLUME, message.volume.toFloat())
                    NativeMics.set(message.slot, NativeMics.ECHO_AMOUNT, message.echo.toFloat())
                }
                is PageMessage.Tap -> if (message.on || message.slot in slots) {
                    slot(message.slot)
                    NativeMics.set(message.slot, NativeMics.TAP, flag(message.on))
                }
                is PageMessage.EchoMix -> {
                    echoWet = message.wet
                    NativeMics.setEchoMix(
                        message.wet.toFloat(),
                        message.feedback.toFloat(),
                        message.lowpassHz.toFloat(),
                        message.reverbSend.toFloat(),
                    )
                }
                is PageMessage.MeasureMonitor -> measureMonitor(message.id, message.slot)
            }
        }

        private fun ignore() {
            ignored.incrementAndGet()
        }

        private fun flag(on: Boolean): Float = if (on) 1f else 0f

        private fun slot(slot: Int): SlotState = slots.getOrPut(slot) { SlotState() }

        private fun offer(offer: PageMessage.Offer) {
            val sdp = when (val filtered = SdpFilter.filter(offer.sdp)) {
                is SdpFilter.Result.Rejected -> {
                    Log.w(TAG, "peer ${offer.peer} slot ${offer.slot} offer ${offer.seq} rejected: ${filtered.reason}")
                    send(AppMessage.PeerError(offer.peer, offer.seq, PeerErrorCode.SDP, filtered.reason))
                    return
                }
                is SdpFilter.Result.Accepted -> filtered.sdp
            }
            val existing = peers[offer.peer]
            if (existing != null) {
                if (existing.slot == offer.slot) {
                    existing.offer(offer.seq, sdp)
                } else {
                    send(AppMessage.PeerError(offer.peer, offer.seq, PeerErrorCode.INTERNAL, "peer moved to another slot"))
                }
                return
            }
            peers.values.filter { it.slot == offer.slot }.forEach {
                peers.remove(it.id)
                it.close()
            }
            val pcf = factory
            val peer = MicPeer(offer.peer, offer.slot, this)
            if (pcf == null || !peer.open(pcf, offer.iceServers)) {
                send(AppMessage.PeerError(offer.peer, offer.seq, PeerErrorCode.INTERNAL, "no peer connection"))
                return
            }
            peers[offer.peer] = peer
            peer.offer(offer.seq, sdp)
        }

        private fun measureMonitor(id: Int, slot: Int) {
            if (slot !in slots) {
                ignore()
                send(AppMessage.MonitorResultFailed(id, slot, MonitorFailReason.NO_AUDIO))
                return
            }
            val started = NativeMics.measureMonitor(slot)
            if (started <= 0) {
                send(AppMessage.MonitorResultFailed(id, slot, reasonOf(-started)))
                return
            }
            val deadline = SystemClock.elapsedRealtime() + MONITOR_LIMIT_MS
            schedule(MONITOR_POLL_MS) { pollMonitor(id, slot, started, deadline) }
        }

        private fun pollMonitor(id: Int, slot: Int, token: Int, deadline: Long) {
            if (state != State.READY) return
            val result = FloatArray(3)
            NativeMics.monitorResult(token, result)
            when (result[0].toInt()) {
                MONITOR_DONE -> {
                    val ms = result[1].toDouble()
                    calibrate(slot, ms)
                    send(AppMessage.MonitorResultOk(id, slot, ms))
                }
                MONITOR_FAILED -> send(AppMessage.MonitorResultFailed(id, slot, reasonOf(result[2].toInt())))
                else -> if (SystemClock.elapsedRealtime() >= deadline) {
                    send(AppMessage.MonitorResultFailed(id, slot, MonitorFailReason.NO_TONE))
                } else {
                    schedule(MONITOR_POLL_MS) { pollMonitor(id, slot, token, deadline) }
                }
            }
        }

        private fun reasonOf(code: Int): MonitorFailReason =
            MonitorFailReason.entries.firstOrNull { it.code == code } ?: MonitorFailReason.STOPPED

        private fun calibrate(slot: Int, ms: Double) {
            val state = slots[slot] ?: return
            NativeMics.slotStatus(slot, status)
            state.calibration = Calibration(ms, state.jitterMs, status[STATUS_FILL_MS].toDouble(), outputLatencyMs)
        }

        /** The last monitor beep, corrected by how jitter buffer, ring fill and output latency moved since. */
        private fun monitorMs(state: SlotState, fillMs: Double): Double? {
            val cal = state.calibration ?: return null
            return cal.ms + delta(state.jitterMs, cal.jitterMs) + (fillMs - cal.fillMs) + delta(outputLatencyMs, cal.outputMs)
        }

        private fun delta(now: Double?, then: Double?): Double = if (now != null && then != null) now - then else 0.0

        private fun sendStatus() {
            val list = slots.map { (slot, state) ->
                NativeMics.slotStatus(slot, status)
                val fillMs = status[STATUS_FILL_MS].toDouble()
                val monitorMs = monitorMs(state, fillMs)
                SlotStatusMsg(
                    slot = slot,
                    attached = status[STATUS_ATTACHED] != 0f,
                    monitored = state.monitored,
                    muted = state.muted,
                    levelRms = status[STATUS_LEVEL_RMS].toDouble(),
                    gateOpen = status[STATUS_GATE_OPEN] != 0f,
                    gateThreshold = GATE_THRESHOLD,
                    feedbackHz = status[STATUS_FEEDBACK_HZ].takeIf { it > 0f }?.toDouble(),
                    boostDb = Math.round(status[STATUS_BOOST_DB] * 10.0) / 10.0,
                    echo = EchoStatusMsg(
                        delayMs = ECHO_DELAY_MS,
                        dryGain = 1.0,
                        wetGain = echoWet,
                        late = monitorMs != null && monitorMs > ECHO_MAX_DELAY_MS,
                    ),
                    mix = SlotMixMsg(state.volume, state.echo),
                    fillMs = fillMs,
                    outRms = status[STATUS_OUT_RMS].toDouble(),
                    monitorMs = monitorMs,
                )
            }
            send(AppMessage.Status(list))
        }

        private fun sendEngineStats() {
            val stats = LongArray(NativeMics.STATS_LEN).also { NativeMics.engineStats(it) }
            outputLatencyMs = latencyMs(stats)
            send(
                EngineStatsMsg(
                    open = stats[STATS_OPEN] != 0L,
                    outputLatencyMs = outputLatencyMs,
                    burstFrames = stats[STATS_BURST_FRAMES],
                    bufferFrames = stats[STATS_BUFFER_FRAMES],
                    xruns = stats[STATS_XRUNS],
                    restarts = stats[STATS_RESTARTS],
                    openAttempts = stats[STATS_OPEN_ATTEMPTS],
                    callbackP99Us = stats[STATS_CALLBACK_P99_US],
                    callbackMaxUs = stats[STATS_CALLBACK_MAX_US],
                    pushIntervalP50Us = stats[STATS_PUSH_INTERVAL_P50_US],
                    pushIntervalP99Us = stats[STATS_PUSH_INTERVAL_P99_US],
                    pushIntervalMaxUs = stats[STATS_PUSH_INTERVAL_MAX_US],
                    pushToPresentP50Ms = stats[STATS_PUSH_TO_PRESENT_P50_US] / 1000.0,
                    pushToPresentP95Ms = stats[STATS_PUSH_TO_PRESENT_P95_US] / 1000.0,
                    tapDropped = stats[STATS_TAP_DROPPED],
                    tapDrainP99Us = stats[STATS_TAP_DRAIN_P99_US],
                    tapDrainMaxUs = stats[STATS_TAP_DRAIN_MAX_US],
                    peak = stats[STATS_PEAK_Q15] / PEAK_FULL_SCALE,
                    sinkErrors = SlotSink.errors.get(),
                    ignored = ignored.get(),
                    apm = apm,
                    slots = slots.keys.map { slot ->
                        val base = STATS_SLOT_BASE + STATS_SLOT_STRIDE * (slot - 1)
                        EngineSlotStatsMsg(slot, stats[base], stats[base + 1], stats[base + 2] * 1000.0 / NativeMics.RATE)
                    },
                ),
            )
        }

        private fun latencyMs(stats: LongArray): Double? =
            stats[STATS_OUTPUT_LATENCY_US].takeIf { it >= 0 }?.let { it / 1000.0 }

        /** Every peer closed as in `close`, then the engine session stopped; a stale token's stop is a no-op. */
        private fun teardown() {
            if (state == State.CLOSED) return
            state = State.CLOSED
            timers.forEach { it.cancel(false) }
            timers.clear()
            val closing = peers.size
            peers.values.forEach { it.close() }
            peers.clear()
            if (token > 0) {
                val stale = token != currentToken
                NativeMics.stop(token)
                if (stale) {
                    Log.i(TAG, "mics session $number closed ($closing peers); stop of stale token $token is a no-op")
                } else {
                    currentToken = 0
                    Log.i(TAG, "mics session $number closed ($closing peers); engine stopped, token $token")
                }
            }
        }
    }
}
