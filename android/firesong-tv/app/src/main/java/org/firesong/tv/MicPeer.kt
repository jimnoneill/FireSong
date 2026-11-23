package org.firesong.tv

import android.os.Process
import android.os.SystemClock
import android.util.Log
import java.nio.ByteBuffer
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.atomic.AtomicLong
import org.webrtc.AudioTrack
import org.webrtc.AudioTrackSink
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.PeerConnection.PeerConnectionState
import org.webrtc.PeerConnectionFactory
import org.webrtc.RTCStats
import org.webrtc.RTCStatsReport
import org.webrtc.RtpReceiver
import org.webrtc.RtpTransceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * When to send `restart-needed` (the rule of remote-mic-peer.ts): FAILED asks at once, DISCONNECTED asks
 * once it has lasted [graceMs]; one ask until the next CONNECTED or the next offer.
 */
class RestartRule(private val graceMs: Long = DISCONNECTED_GRACE_MS) {
    private var asked = false
    private var disconnectedSinceMs: Long? = null

    /** A connection state change; true when `restart-needed` is due now. */
    fun onState(state: PeerConnectionState, nowMs: Long): Boolean = when (state) {
        PeerConnectionState.CONNECTED -> {
            asked = false
            disconnectedSinceMs = null
            false
        }
        PeerConnectionState.FAILED -> ask()
        PeerConnectionState.DISCONNECTED -> {
            if (disconnectedSinceMs == null) disconnectedSinceMs = nowMs
            false
        }
        else -> false
    }

    /** When the caller should run [onTimer], or null when no DISCONNECTED grace is running. */
    fun dueAtMs(): Long? = disconnectedSinceMs?.plus(graceMs)

    /** The grace check; true when the connection is still DISCONNECTED after [graceMs]. */
    fun onTimer(state: PeerConnectionState, nowMs: Long): Boolean {
        val since = disconnectedSinceMs ?: return false
        if (nowMs - since < graceMs) return false
        disconnectedSinceMs = null
        return state == PeerConnectionState.DISCONNECTED && ask()
    }

    fun onOffer() {
        asked = false
    }

    private fun ask(): Boolean {
        if (asked) return false
        asked = true
        return true
    }

    companion object {
        const val DISCONNECTED_GRACE_MS = 3000L
    }
}

/**
 * The offers of one peer, negotiated one at a time in `seq` order. A negotiation that finishes while a newer
 * offer waits sends `peer-error superseded` instead of its answer, and of several waiting offers only the
 * newest runs. Nothing is sent after [close]. Not thread-safe: fs-mics only.
 */
class NegotiationQueue(
    private val peer: Int,
    private val begin: (seq: Int, sdp: String) -> Unit,
    private val send: (AppMessage) -> Unit,
) {
    private var running: Int? = null
    private var waitingSeq = 0
    private var waitingSdp: String? = null
    private var lastSeq = 0
    private var closed = false

    fun offer(seq: Int, sdp: String) {
        if (closed) return
        if (seq <= lastSeq) {
            send(AppMessage.PeerError(peer, seq, PeerErrorCode.INTERNAL, "offer seq not increasing"))
            return
        }
        lastSeq = seq
        if (waitingSdp != null) superseded(waitingSeq)
        waitingSeq = seq
        waitingSdp = sdp
        if (running == null) next()
    }

    fun isRunning(seq: Int): Boolean = !closed && running == seq

    fun answered(seq: Int, sdp: String) = finish(seq) { AppMessage.Answer(peer, seq, sdp) }

    fun failed(seq: Int, code: PeerErrorCode, detail: String) =
        finish(seq) { AppMessage.PeerError(peer, seq, code, detail) }

    fun close() {
        closed = true
        running = null
        waitingSdp = null
    }

    private fun finish(seq: Int, result: () -> AppMessage) {
        if (!isRunning(seq)) return
        running = null
        if (waitingSdp != null) superseded(seq) else send(result())
        next()
    }

    private fun next() {
        val sdp = waitingSdp ?: return
        waitingSdp = null
        running = waitingSeq
        begin(waitingSeq, sdp)
    }

    private fun superseded(seq: Int) = send(AppMessage.PeerError(peer, seq, PeerErrorCode.SUPERSEDED, "a newer offer"))
}

/** What a [MicPeer] needs from its session; every call is made on fs-mics. */
internal interface PeerHost {
    val channel: PageChannel

    fun send(message: AppMessage)

    fun post(task: () -> Unit)

    fun schedule(delayMs: Long, task: () -> Unit): ScheduledFuture<*>

    /** A new engine generation for an attach; unique for the process. */
    fun nextGen(): Int

    fun attached(peer: MicPeer)

    fun statsUpdated(peer: MicPeer)
}

/**
 * One phone's receive-only PeerConnection. Runs on fs-mics; WebRTC observer callbacks only post there, and
 * every posted callback first checks [closed].
 */
internal class MicPeer(val id: Int, val slot: Int, private val host: PeerHost) {
    var closed = false
        private set

    /** The engine generation of the attached track; 0 before the track arrives. */
    var gen = 0
        private set

    /** Mean jitter-buffer delay over the last stats interval, ms; null until two readings. */
    var jitterMs: Double? = null
        private set

    private var pc: PeerConnection? = null
    private val queue = NegotiationQueue(id, ::begin, host::send)
    private val restart = RestartRule()
    private var link = PeerConnectionState.NEW
    private var remoteReady = false
    private val pendingIce = ArrayList<IceCandidate>()
    private val transceivers = ArrayList<RtpTransceiver>()
    private var track: AudioTrack? = null
    private var sink: SlotSink? = null
    private var gatherSeq = 0
    private var answerTimer: ScheduledFuture<*>? = null
    private var gatherTimer: ScheduledFuture<*>? = null
    private var disconnectedTimer: ScheduledFuture<*>? = null
    private var jitterDelay = 0.0
    private var jitterEmitted = -1.0

    /** Creates the PeerConnection; false when libwebrtc refuses. */
    fun open(factory: PeerConnectionFactory, iceServers: List<IceServerSpec>): Boolean {
        val servers = iceServers.map { server ->
            PeerConnection.IceServer.builder(server.urls)
                .setUsername(server.username ?: "")
                .setPassword(server.credential ?: "")
                .createIceServer()
        }
        val config = PeerConnection.RTCConfiguration(servers).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            tcpCandidatePolicy = PeerConnection.TcpCandidatePolicy.DISABLED
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_ONCE
            keyType = PeerConnection.KeyType.ECDSA
            maxIPv6Networks = 0
        }
        val created = factory.createPeerConnection(config, Observer()) ?: return false
        created.setAudioPlayout(false)
        created.setAudioRecording(false)
        pc = created
        return true
    }

    /** An offer that passed [SdpFilter]; answered or refused through the negotiation queue. */
    fun offer(seq: Int, sdp: String) = queue.offer(seq, sdp)

    fun addIce(spec: IceCandidateSpec) {
        val connection = pc ?: return
        if (closed) return
        val candidate = IceCandidate(spec.sdpMid ?: "", spec.sdpMLineIndex ?: 0, spec.candidate)
        if (remoteReady) {
            connection.addIceCandidate(candidate)
        } else if (pendingIce.size < MAX_PENDING_ICE) {
            pendingIce.add(candidate)
        }
    }

    fun requestStats() {
        val connection = pc ?: return
        if (closed) return
        connection.getStats { report -> host.post { if (!closed) onStats(report) } }
    }

    /** The `close` of design §3.1.3; idempotent. */
    fun close() {
        if (closed) return
        closed = true
        cancelNegotiationTimers()
        disconnectedTimer?.cancel(false)
        disconnectedTimer = null
        queue.close()
        val attachedTrack = track
        val attachedSink = sink
        if (attachedTrack != null && attachedSink != null) attachedTrack.removeSink(attachedSink)
        if (gen != 0) {
            NativeMics.detach(slot, gen)
            host.channel.wakeTap()
        }
        pc?.close()
        transceivers.forEach { it.dispose() }
        transceivers.clear()
        pc?.dispose()
        pc = null
        track = null
        sink = null
        pendingIce.clear()
    }

    private fun begin(seq: Int, sdp: String) {
        val connection = pc ?: return
        restart.onOffer()
        remoteReady = false
        answerTimer = host.schedule(ANSWER_TIMEOUT_MS) {
            if (!closed && queue.isRunning(seq)) fail(seq, PeerErrorCode.TIMEOUT, "no answer within ${ANSWER_TIMEOUT_MS / 1000} s")
        }
        connection.setRemoteDescription(
            Step(seq, PeerErrorCode.SDP, "setRemoteDescription", set = { onRemoteSet(seq) }),
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
    }

    private fun onRemoteSet(seq: Int) {
        val connection = pc ?: return
        remoteReady = true
        pendingIce.forEach { connection.addIceCandidate(it) }
        pendingIce.clear()
        connection.createAnswer(
            Step(seq, PeerErrorCode.INTERNAL, "createAnswer", created = { onAnswerCreated(seq, it) }),
            MediaConstraints(),
        )
    }

    private fun onAnswerCreated(seq: Int, answer: SessionDescription) {
        pc?.setLocalDescription(
            Step(seq, PeerErrorCode.INTERNAL, "setLocalDescription", set = { onLocalSet(seq) }),
            answer,
        )
    }

    private fun onLocalSet(seq: Int) {
        val connection = pc ?: return
        if (connection.iceGatheringState() == PeerConnection.IceGatheringState.COMPLETE) {
            answer(seq)
            return
        }
        gatherSeq = seq
        gatherTimer = host.schedule(GATHER_TIMEOUT_MS) { if (!closed && queue.isRunning(seq)) answer(seq) }
    }

    private fun answer(seq: Int) {
        cancelNegotiationTimers()
        val sdp = pc?.localDescription?.description
        if (sdp == null) {
            fail(seq, PeerErrorCode.INTERNAL, "no local description")
        } else {
            queue.answered(seq, sdp)
        }
    }

    private fun fail(seq: Int, code: PeerErrorCode, detail: String) {
        cancelNegotiationTimers()
        Log.w(TAG, "peer $id slot $slot offer $seq: $detail")
        queue.failed(seq, code, detail)
    }

    private fun cancelNegotiationTimers() {
        answerTimer?.cancel(false)
        answerTimer = null
        gatherTimer?.cancel(false)
        gatherTimer = null
        gatherSeq = 0
    }

    private fun onGatheringComplete() {
        val seq = gatherSeq
        if (seq != 0 && queue.isRunning(seq)) answer(seq)
    }

    private fun onConnectionState(state: PeerConnectionState) {
        link = state
        Log.i(TAG, "peer $id slot $slot: $state")
        val now = SystemClock.elapsedRealtime()
        if (restart.onState(state, now)) host.send(AppMessage.RestartNeeded(id))
        if (state == PeerConnectionState.CONNECTED) {
            disconnectedTimer?.cancel(false)
            disconnectedTimer = null
        }
        val due = restart.dueAtMs()
        if (due != null && disconnectedTimer == null) {
            disconnectedTimer = host.schedule(maxOf(0L, due - now)) {
                disconnectedTimer = null
                if (!closed && restart.onTimer(link, SystemClock.elapsedRealtime())) {
                    host.send(AppMessage.RestartNeeded(id))
                }
            }
        }
    }

    private fun attachTrack(transceiver: RtpTransceiver) {
        transceivers.add(transceiver)
        if (transceiver.mediaType != MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO) return
        val audio = transceiver.receiver.track() as? AudioTrack ?: return
        val previousTrack = track
        val previousSink = sink
        if (previousTrack != null && previousSink != null) previousTrack.removeSink(previousSink)
        val next = host.nextGen()
        NativeMics.attach(slot, next)
        val slotSink = SlotSink(slot, next, host.channel)
        audio.addSink(slotSink)
        track = audio
        sink = slotSink
        gen = next
        Log.i(TAG, "peer $id slot $slot: track attached, gen $next")
        host.attached(this)
    }

    private fun onStats(report: RTCStatsReport) {
        val stats = report.statsMap
        val inbound = stats.values.firstOrNull { it.type == "inbound-rtp" && it.members["kind"] == "audio" } ?: return
        val pair = selectedPair(stats)
        val local = (pair?.members?.get("localCandidateId") as? String)?.let { stats[it] }
        val localType = local?.members?.get("candidateType") as? String
        val delay = inbound.number("jitterBufferDelay") ?: 0.0
        val emitted = inbound.number("jitterBufferEmittedCount") ?: 0.0
        jitterMs = if (jitterEmitted >= 0 && emitted > jitterEmitted) {
            (delay - jitterDelay) / (emitted - jitterEmitted) * 1000
        } else {
            jitterMs
        }
        jitterDelay = delay
        jitterEmitted = emitted
        host.send(
            AppMessage.PeerStats(
                peer = id,
                jitterBufferDelay = delay,
                jitterBufferEmittedCount = emitted,
                jitterBufferTargetDelay = inbound.number("jitterBufferTargetDelay") ?: 0.0,
                packetsReceived = inbound.number("packetsReceived") ?: 0.0,
                packetsLost = inbound.number("packetsLost") ?: 0.0,
                concealedSamples = inbound.number("concealedSamples") ?: 0.0,
                concealmentEvents = inbound.number("concealmentEvents") ?: 0.0,
                insertedSamplesForDeceleration = inbound.number("insertedSamplesForDeceleration") ?: 0.0,
                removedSamplesForAcceleration = inbound.number("removedSamplesForAcceleration") ?: 0.0,
                jitter = inbound.number("jitter") ?: 0.0,
                roundTripTimeMs = pair?.number("currentRoundTripTime")?.let { it * 1000 },
                candidateType = CandidateType.entries.firstOrNull { it.wire == localType },
            ),
        )
        host.statsUpdated(this)
    }

    /** The nominated, succeeded candidate pair; the transport's selected one when it names one. */
    private fun selectedPair(stats: Map<String, RTCStats>): RTCStats? {
        val pairs = stats.values.filter {
            it.type == "candidate-pair" && it.members["nominated"] == true && it.members["state"] == "succeeded"
        }
        val selectedId = stats.values.firstOrNull { it.type == "transport" }?.members?.get("selectedCandidatePairId")
        return pairs.firstOrNull { it.id == selectedId } ?: pairs.firstOrNull()
    }

    private fun RTCStats.number(key: String): Double? = (members[key] as? Number)?.toDouble()

    /** Runs a description step's result on fs-mics, only while its offer is still the running one. */
    private inner class Step(
        private val seq: Int,
        private val failure: PeerErrorCode,
        private val stage: String,
        private val created: (SessionDescription) -> Unit = {},
        private val set: () -> Unit = {},
    ) : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription) = onFsMics { created(description) }

        override fun onSetSuccess() = onFsMics(set)

        override fun onCreateFailure(error: String?) = onFsMics { fail(seq, failure, "$stage failed") }

        override fun onSetFailure(error: String?) = onFsMics { fail(seq, failure, "$stage failed") }

        private fun onFsMics(action: () -> Unit) = host.post { if (!closed && queue.isRunning(seq)) action() }
    }

    /** Called on libwebrtc's signaling thread: only posts to fs-mics. */
    private inner class Observer : PeerConnection.Observer {
        override fun onSignalingChange(state: PeerConnection.SignalingState) = Unit

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState) = Unit

        override fun onConnectionChange(state: PeerConnectionState) = host.post { if (!closed) onConnectionState(state) }

        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit

        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState) {
            if (state == PeerConnection.IceGatheringState.COMPLETE) host.post { if (!closed) onGatheringComplete() }
        }

        override fun onIceCandidate(candidate: IceCandidate) = Unit

        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>) = Unit

        override fun onAddStream(stream: MediaStream) = Unit

        override fun onRemoveStream(stream: MediaStream) = Unit

        override fun onDataChannel(channel: DataChannel) = host.post {
            channel.close()
            channel.dispose()
        }

        override fun onRenegotiationNeeded() = Unit

        /** The wrapper is ours to dispose; the streams belong to the observer. */
        override fun onAddTrack(receiver: RtpReceiver, streams: Array<out MediaStream>) = host.post { receiver.dispose() }

        override fun onRemoveTrack(receiver: RtpReceiver) = host.post { receiver.dispose() }

        override fun onTrack(transceiver: RtpTransceiver) = host.post {
            if (closed) transceiver.dispose() else attachTrack(transceiver)
        }
    }

    companion object {
        const val ANSWER_TIMEOUT_MS = 5000L
        const val GATHER_TIMEOUT_MS = 2000L
        private const val MAX_PENDING_ICE = 64
        private const val TAG = "FireSong"
    }
}

/**
 * Hands one slot's decoded 10 ms frames to the engine, on libwebrtc's worker thread (its 10 ms poller). It
 * never throws back into JNI: an exception there would abort the process.
 */
internal class SlotSink(private val slot: Int, private val gen: Int, private val channel: PageChannel) : AudioTrackSink {
    override fun onData(
        audioData: ByteBuffer,
        bitsPerSample: Int,
        sampleRate: Int,
        numberOfChannels: Int,
        numberOfFrames: Int,
        absoluteCaptureTimestampMs: Long,
    ) {
        try {
            val thread = Thread.currentThread()
            if (thread !== urgentThread) {
                urgentThread = thread
                Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
            }
            if (bitsPerSample != PCM_BITS) {
                errors.incrementAndGet()
            } else if (NativeMics.push(slot, gen, audioData, numberOfFrames, sampleRate, numberOfChannels) > 0) {
                channel.wakeTap()
            }
        } catch (_: Throwable) {
            errors.incrementAndGet()
        }
    }

    companion object {
        private const val PCM_BITS = 16

        /** Throwables and unusable frames in every sink of the process. */
        val errors = AtomicLong()

        /** The last thread raised to URGENT_AUDIO, as WebRtcAudioTrack raises its own. */
        @Volatile private var urgentThread: Thread? = null
    }
}
