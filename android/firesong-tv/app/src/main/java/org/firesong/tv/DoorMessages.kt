package org.firesong.tv

/**
 * The voice door protocol between the TV page and the app (version [DOOR_VERSION]).
 * Each class is one JSON message; [PageMessage.t] and [AppMessage.t] are the wire
 * names and every field keeps its wire name. Slots are 1..4; `peer` ids are chosen
 * by the page, unique per connection.
 */
const val DOOR_VERSION = 2

/** The feature this protocol version defines; either side uses a feature only when both list it. */
const val FEATURE_MICS = "mics"

data class IceServerSpec(val urls: List<String>, val username: String?, val credential: String?)

data class IceCandidateSpec(val candidate: String, val sdpMid: String?, val sdpMLineIndex: Int?)

sealed class PageMessage(val t: String) {
    data class Hello(val v: Int, val features: List<String>) : PageMessage("hello")

    data class Offer(
        val peer: Int,
        val seq: Int,
        val slot: Int,
        val micId: String,
        val sdp: String,
        val iceServers: List<IceServerSpec>,
    ) : PageMessage("offer")

    /** `candidate` null is the end of candidates. */
    data class Ice(val peer: Int, val candidate: IceCandidateSpec?) : PageMessage("ice")

    data class Close(val peer: Int) : PageMessage("close")

    data class Detach(val slot: Int) : PageMessage("detach")

    data class Release(val slot: Int) : PageMessage("release")

    data class Monitor(val slot: Int, val on: Boolean) : PageMessage("monitor")

    data class Mute(val slot: Int, val muted: Boolean) : PageMessage("mute")

    /** `volume` 0..1.5, `echo` 0..2. */
    data class Mix(val slot: Int, val volume: Double, val echo: Double) : PageMessage("mix")

    data class Tap(val slot: Int, val on: Boolean) : PageMessage("tap")

    /** `wet` 0..1, `feedback` 0..0.95, `lowpassHz` 500..20000, `reverbSend` 0..1. */
    data class EchoMix(val wet: Double, val feedback: Double, val lowpassHz: Double, val reverbSend: Double) :
        PageMessage("echo-mix")

    data class MeasureMonitor(val id: Int, val slot: Int) : PageMessage("measure-monitor")
}

sealed class AppMessage(val t: String) {
    /** On the wire with `v` and `ok: true`. `audio` is "open" or "pending". */
    data class ReadyOk(
        val features: List<String>,
        val audio: String,
        val rate: Int,
        val burstFrames: Int?,
        val outputLatencyMs: Double?,
    ) : AppMessage("ready")

    /** On the wire with `v` and `ok: false`. `reason` is "lib" or "webrtc". */
    data class ReadyFailed(val reason: String) : AppMessage("ready")

    /** The raw local description, candidates included. */
    data class Answer(val peer: Int, val seq: Int, val sdp: String) : AppMessage("answer")

    /** `code` is "sdp", "timeout", "internal" or "superseded"; `detail` at most 200 chars, no SDP or addresses. */
    data class PeerError(val peer: Int, val seq: Int, val code: String, val detail: String) : AppMessage("peer-error")

    data class RestartNeeded(val peer: Int) : AppMessage("restart-needed")

    /**
     * The peer's inbound audio stream, cumulative as RTCStats reports it (delays in seconds, counts in
     * samples or packets). `candidateType` is "host", "srflx", "prflx", "relay" or null.
     */
    data class PeerStats(
        val peer: Int,
        val jitterBufferDelay: Double,
        val jitterBufferEmittedCount: Double,
        val jitterBufferTargetDelay: Double,
        val packetsReceived: Double,
        val packetsLost: Double,
        val concealedSamples: Double,
        val concealmentEvents: Double,
        val insertedSamplesForDeceleration: Double,
        val removedSamplesForAcceleration: Double,
        val jitter: Double,
        val roundTripTimeMs: Double?,
        val candidateType: String?,
    ) : AppMessage("peer-stats")

    data class Status(val slots: List<SlotStatusMsg>) : AppMessage("status")

    data class MonitorResultOk(val id: Int, val slot: Int, val monitorMs: Double) : AppMessage("monitor-result")

    /** On the wire with `ok: false`. `reason` is "busy", "no-audio", "no-tone" or "stopped". */
    data class MonitorResultFailed(val id: Int, val slot: Int, val reason: String) : AppMessage("monitor-result")

    /** `reason` is "webrtc" or "internal"; the app closes the socket after sending it. */
    data class Fatal(val reason: String) : AppMessage("fatal")
}

data class EchoStatusMsg(val delayMs: Double, val dryGain: Double, val wetGain: Double, val late: Boolean)

data class SlotMixMsg(val volume: Double, val echo: Double)

data class SlotStatusMsg(
    val slot: Int,
    val attached: Boolean,
    val monitored: Boolean,
    val muted: Boolean,
    val levelRms: Double,
    val gateOpen: Boolean,
    val gateThreshold: Double,
    val feedbackHz: Double?,
    val boostDb: Double,
    val echo: EchoStatusMsg,
    val mix: SlotMixMsg,
    val fillMs: Double,
    val outRms: Double,
    val monitorMs: Double?,
)

data class EngineSlotStatsMsg(val slot: Int, val underruns: Long, val trimmedFrames: Long, val marginMs: Double)

/** `apm` is null until known, then "none" or the effective components, e.g. "ec:SOFTWARE,ns:SOFTWARE". */
data class EngineStatsMsg(
    val open: Boolean,
    val outputLatencyMs: Double?,
    val burstFrames: Long,
    val bufferFrames: Long,
    val xruns: Long,
    val restarts: Long,
    val openAttempts: Long,
    val callbackP99Us: Long,
    val callbackMaxUs: Long,
    val pushIntervalP50Us: Long,
    val pushIntervalP99Us: Long,
    val pushIntervalMaxUs: Long,
    val pushToPresentP50Ms: Double,
    val pushToPresentP95Ms: Double,
    val tapDropped: Long,
    val tapDrainP99Us: Long,
    val tapDrainMaxUs: Long,
    val peak: Double,
    val sinkErrors: Long,
    val ignored: Long,
    val apm: String?,
    val slots: List<EngineSlotStatsMsg>,
) : AppMessage("engine-stats")

/** The door's side of one page connection. Every method may be called from any thread. */
interface PageChannel {
    fun send(message: AppMessage)

    /** Tap blocks are waiting in the engine: drain them now. */
    fun wakeTap()

    fun close(code: Int)
}

/** The app's side of one page connection. */
interface PageHandler {
    fun onMessage(message: PageMessage)

    /** The door tolerated something it did not deliver (an unknown `t` or an unknown field); counted in engine-stats `ignored`. */
    fun onIgnored()

    /** The connection ended; called exactly once. */
    fun onClosed()
}
