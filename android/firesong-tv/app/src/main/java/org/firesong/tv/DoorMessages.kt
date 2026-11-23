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

/** `usernameFragment` is part of the page's candidate; libwebrtc's IceCandidate has no use for it. */
data class IceCandidateSpec(
    val candidate: String,
    val sdpMid: String?,
    val sdpMLineIndex: Int?,
    val usernameFragment: String?,
)

/** The value sets of the app's enum fields; [wire] is the JSON string. */
enum class ReadyAudio(val wire: String) { OPEN("open"), PENDING("pending") }

enum class ReadyFailReason(val wire: String) { LIB("lib"), WEBRTC("webrtc") }

enum class PeerErrorCode(val wire: String) {
    SDP("sdp"),
    TIMEOUT("timeout"),
    INTERNAL("internal"),
    SUPERSEDED("superseded"),
}

enum class CandidateType(val wire: String) { HOST("host"), SRFLX("srflx"), PRFLX("prflx"), RELAY("relay") }

/** [code] is the engine's reason: NativeMics.monitorResult out[2], or minus the return of NativeMics.measureMonitor. */
enum class MonitorFailReason(val code: Int, val wire: String) {
    BUSY(1, "busy"),
    NO_AUDIO(2, "no-audio"),
    NO_TONE(3, "no-tone"),
    STOPPED(4, "stopped"),
}

enum class FatalReason(val wire: String) { WEBRTC("webrtc"), INTERNAL("internal") }

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

    /** `wet` 0..1, `feedback` 0..0.6 (the echo loop's stable range), `lowpassHz` 500..20000, `reverbSend` 0..1. */
    data class EchoMix(val wet: Double, val feedback: Double, val lowpassHz: Double, val reverbSend: Double) :
        PageMessage("echo-mix")

    data class MeasureMonitor(val id: Int, val slot: Int) : PageMessage("measure-monitor")
}

sealed class AppMessage(val t: String) {
    /**
     * On the wire with `v` and `ok: true`. [outputLatencyMs] waits for the output's first timestamp, about 50 ms
     * after it opens, so a session that has just opened the output says null here; `engine-stats` carries it.
     */
    data class ReadyOk(
        val features: List<String>,
        val audio: ReadyAudio,
        val rate: Int,
        val burstFrames: Int?,
        val outputLatencyMs: Double?,
    ) : AppMessage("ready")

    /**
     * On the wire with `v` and `ok: false`. `webrtc`: libwebrtc already failed to start in this process; a first
     * failure comes after `ready`, as [Fatal] `webrtc`.
     */
    data class ReadyFailed(val reason: ReadyFailReason) : AppMessage("ready")

    /** The raw local description, candidates included. */
    data class Answer(val peer: Int, val seq: Int, val sdp: String) : AppMessage("answer")

    /**
     * `detail` carries no SDP or addresses. The wire limit is [DETAIL_MAX] chars: DoorCodec.encode sends
     * at most its first [DETAIL_MAX], so producers may pass a longer one.
     */
    data class PeerError(val peer: Int, val seq: Int, val code: PeerErrorCode, val detail: String) :
        AppMessage("peer-error") {
        companion object {
            const val DETAIL_MAX = 200
        }
    }

    data class RestartNeeded(val peer: Int) : AppMessage("restart-needed")

    /**
     * The peer's inbound audio stream, cumulative as RTCStats reports it (delays in seconds, counts in
     * samples or packets). `candidateType` is null until a candidate pair is nominated.
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
        val candidateType: CandidateType?,
    ) : AppMessage("peer-stats")

    data class Status(val slots: List<SlotStatusMsg>) : AppMessage("status")

    data class MonitorResultOk(val id: Int, val slot: Int, val monitorMs: Double) : AppMessage("monitor-result")

    /** On the wire with `ok: false`. */
    data class MonitorResultFailed(val id: Int, val slot: Int, val reason: MonitorFailReason) :
        AppMessage("monitor-result")

    /** The app closes the socket after sending it. */
    data class Fatal(val reason: FatalReason) : AppMessage("fatal")
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

/**
 * Every second. The `P50`/`P95`/`P99`/`Max` fields cover one window, the samples since the previous engine-stats
 * (the engine starts a new window at most once per 900 ms, so each is about 1 s). Cumulative since this
 * connection's `hello` started the engine: `xruns`, `restarts`, `openAttempts` (AAudio open attempts),
 * `tapDropped`, `trims` (trim splices), `jumps` (ceiling jumps), `inserts` (insert splices), `insertedFrames`,
 * `clampHits` (output frames the voice ceiling clamp cut), and per slot `underruns` and `trimmedFrames` (trims and
 * jumps). `sinkErrors` counts since the app started, `ignored` since this connection opened. `peak` is the output
 * peak since the previous engine-stats. `apm` is null until known, then "none" or the effective components, e.g.
 * "ec:SOFTWARE,ns:SOFTWARE".
 */
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
    val trims: Long,
    val jumps: Long,
    val inserts: Long,
    val insertedFrames: Long,
    val clampHits: Long,
    val peak: Double,
    val sinkErrors: Long,
    val ignored: Long,
    val apm: String?,
    val slots: List<EngineSlotStatsMsg>,
) : AppMessage("engine-stats")

/** The door's side of one page connection. Every method may be called from any thread. */
interface PageChannel {
    fun send(message: AppMessage)

    /**
     * Tap blocks are waiting in the engine: drain them now. Never blocks or allocates, because the sinks call it on
     * libwebrtc's audio thread.
     */
    fun wakeTap()

    fun close(code: Int)
}

/**
 * The app's side of one page connection. No [onMessage] or [onIgnored] follows [onClosed]. Callbacks must not
 * block or call into the door: the door may wait for a callback in progress to return (on a replacement or
 * `VoiceDoor.close()`).
 */
interface PageHandler {
    fun onMessage(message: PageMessage)

    /**
     * The door tolerated a frame: an unknown `t` (not delivered), or unknown fields (the message is
     * delivered first). Each call adds 1 to engine-stats `ignored`.
     */
    fun onIgnored()

    /** The connection ended; called exactly once. */
    fun onClosed()
}
