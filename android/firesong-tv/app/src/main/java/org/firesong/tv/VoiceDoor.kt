package org.firesong.tv

import android.os.Process
import android.util.Log
import android.webkit.JavascriptInterface
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketTimeoutException
import java.nio.ByteBuffer
import java.security.SecureRandom
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.concurrent.locks.LockSupport

/**
 * The page's way into the native voice engine: a WebSocket on 127.0.0.1 that the TV page connects to, with a
 * per-launch token in the path and the TV origin checked. The page reads the address from
 * `window.FireSongVoice.endpoint()`. One connection at a time: a new one replaces the old, and the old
 * connection's handler hears [PageHandler.onClosed] before the new connection's first frame is read. Each
 * connection gets its own [PageHandler] from [handlerFor].
 *
 * Threads per connection: `fs-voice-in` reads frames and hands page messages to the handler; `fs-voice-out` is
 * the socket's only writer after the upgrade, sending the handler's messages and the engine's tap blocks.
 */
class VoiceDoor(
    private val allowedOrigin: () -> String?,
    private val handlerFor: (PageChannel) -> PageHandler,
) {
    private val token = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }
    private val lock = Any()

    @Volatile private var server: ServerSocket? = null
    private var current: Connection? = null

    fun open() {
        if (!NativeMics.available || server != null) return
        val socket = try {
            ServerSocket(0, 2, InetAddress.getByName(LOOPBACK))
        } catch (e: IOException) {
            Log.w(TAG, "voice door not opened: ${e.message}")
            return
        }
        server = socket
        Thread({ accept(socket) }, "fs-voice-door").apply { isDaemon = true }.start()
        Log.i(TAG, "voice door on $LOOPBACK:${socket.localPort}")
    }

    /** Stops listening and ends the page connection; its handler's teardown is only posted from here. */
    fun close() {
        val listener = server
        server = null
        listener?.let { closeQuietly(it) }
        synchronized(lock) { current }?.end()
    }

    fun endpoint(): String {
        val listener = server ?: return ""
        return "{\"version\":$DOOR_VERSION,\"url\":\"ws://$LOOPBACK:${listener.localPort}$PATH?t=$token\"," +
            "\"features\":[\"$FEATURE_MICS\"]}"
    }

    /** `window.FireSongVoice` for the page. */
    class Js(private val door: VoiceDoor) {
        @JavascriptInterface
        fun endpoint(): String = door.endpoint()
    }

    private fun accept(listener: ServerSocket) {
        while (!listener.isClosed) {
            val incoming = try {
                listener.accept()
            } catch (_: IOException) {
                break
            }
            Thread({ serve(listener, incoming) }, "fs-voice-in").apply { isDaemon = true }.start()
        }
    }

    private fun serve(listener: ServerSocket, socket: Socket) {
        var connection: Connection? = null
        try {
            socket.tcpNoDelay = true
            val raw = DeadlineInput(socket, socket.getInputStream())
            val input = BufferedInputStream(raw, IN_BUFFER)
            val output = socket.getOutputStream()
            raw.arm(HANDSHAKE_TIMEOUT_MS)
            val head = readHead(input)
            val upgrade = if (head == null) {
                WsHandshake.Result.Refuse(WsHandshake.BAD_REQUEST)
            } else {
                WsHandshake.check(head, "$PATH?t=$token", allowedOrigin())
            }
            when (upgrade) {
                is WsHandshake.Result.Refuse -> {
                    Log.w(TAG, "voice door refused a connection: ${upgrade.status}")
                    output.write(WsHandshake.refusal(upgrade.status))
                    output.flush()
                }
                is WsHandshake.Result.Accept -> {
                    val accepted = Connection(socket, raw, input, output)
                    connection = accepted
                    if (!admit(listener, accepted)) return
                    output.write(WsHandshake.switching(upgrade.accept))
                    output.flush()
                    raw.arm(HELLO_TIMEOUT_MS)
                    Log.i(TAG, "voice page connected")
                    accepted.run()
                }
            }
        } catch (_: IOException) {
            // The page went away during the upgrade, or the door closed.
        } catch (e: RuntimeException) {
            Log.w(TAG, "voice door connection failed: ${e.javaClass.simpleName}")
        } finally {
            if (connection == null) closeQuietly(socket) else connection.end()
        }
    }

    /** Makes [connection] the door's one connection, ending the one it replaces first; false once the door is closed. */
    private fun admit(listener: ServerSocket, connection: Connection): Boolean = synchronized(lock) {
        if (server !== listener) {
            connection.end()
            return false
        }
        val replaced = current
        current = connection
        replaced?.end()
        true
    }

    private fun released(connection: Connection) {
        synchronized(lock) {
            if (current === connection) current = null
        }
    }

    /** The request line and header lines, or null when the head is too long; throws at the deadline or the end of the stream. */
    private fun readHead(input: InputStream): List<String>? {
        val head = StringBuilder()
        while (head.length < MAX_HEAD) {
            val b = input.read()
            if (b < 0) throw IOException("closed")
            head.append(b.toChar())
            if (head.endsWith("\r\n\r\n")) return head.trimEnd().split("\r\n")
        }
        return null
    }

    /** One page connection after its upgrade, as the session sees it. */
    private inner class Connection(
        private val socket: Socket,
        private val deadline: DeadlineInput,
        private val input: InputStream,
        private val output: OutputStream,
    ) : PageChannel {
        private val ended = AtomicBoolean(false)
        private val texts = ConcurrentLinkedQueue<ByteArray>()
        private val queued = AtomicInteger(0)
        private val closeCode = AtomicInteger(0)
        private val pong = AtomicReference<ByteArray?>(null)

        @Volatile private var overflowed = false

        @Volatile private var readerDone = false

        @Volatile private var reader: Thread? = null

        @Volatile private var writer: Thread? = null

        /** Created last: the session may use this channel as soon as it exists. */
        private val handler: PageHandler = handlerFor(this)

        override fun send(message: AppMessage) {
            if (ended.get() || closeCode.get() != 0) return
            val bytes = DoorCodec.encode(message).toByteArray(Charsets.UTF_8)
            if (queued.incrementAndGet() > TEXT_QUEUE_MAX) {
                queued.decrementAndGet()
                overflowed = true
                requestClose(DoorCodec.CLOSE_INTERNAL)
                return
            }
            texts.add(bytes)
            wakeWriter()
        }

        override fun wakeTap() = wakeWriter()

        override fun close(code: Int) = requestClose(if (WsFrames.validCloseCode(code)) code else DoorCodec.CLOSE_INTERNAL)

        /** Reads on this thread (`fs-voice-in`) after starting the writer; returns once the connection has ended. */
        fun run() {
            reader = Thread.currentThread()
            val out = Thread({ write() }, "fs-voice-out").apply { isDaemon = true }
            writer = out
            out.start()
            val closing = try {
                read()
                true
            } catch (_: IOException) {
                false
            }
            readerDone = true
            LockSupport.unpark(out)
            if (closing) awaitEnd()
            end()
        }

        /** Idempotent, from any thread: closes the socket and tells the handler, exactly once. */
        fun end() {
            if (!ended.compareAndSet(false, true)) return
            closeQuietly(socket)
            writer?.let { LockSupport.unpark(it) }
            reader?.let { LockSupport.unpark(it) }
            released(this)
            handler.onClosed()
            Log.i(TAG, "voice page disconnected")
        }

        /** Returns normally once a close was asked for (by the page or by a broken rule); throws at the end of the stream. */
        private fun read() {
            val frames = WsReader(input)
            val gate = HelloGate()
            while (true) {
                val event = try {
                    frames.next()
                } catch (_: SocketTimeoutException) {
                    return fail(DoorCodec.CLOSE_POLICY)
                }
                when (event) {
                    is WsEvent.Text -> if (closeCode.get() == 0) {
                        when (val result = gate.admit(DoorCodec.parsePage(event.text))) {
                            is ParseResult.Message -> {
                                deadline.disarm()
                                handler.onMessage(result.message)
                                if (result.unknownFields) handler.onIgnored()
                            }
                            ParseResult.Ignored -> handler.onIgnored()
                            is ParseResult.Fatal -> return fail(result.code)
                        }
                    }
                    is WsEvent.Ping -> {
                        pong.set(event.payload)
                        wakeWriter()
                    }
                    WsEvent.Pong -> Unit
                    is WsEvent.Close -> {
                        requestClose(if (event.code == DoorCodec.CLOSE_NO_STATUS) DoorCodec.CLOSE_NORMAL else event.code)
                        return
                    }
                    is WsEvent.Fail -> return fail(event.code)
                }
            }
        }

        /** Asks the writer to close with [code], then drops the page's bytes until it hangs up or the writer gives up. */
        private fun fail(code: Int) {
            requestClose(code)
            deadline.disarm()
            val sink = ByteArray(DISCARD_BUFFER)
            try {
                while (input.read(sink) >= 0) Unit
            } catch (_: IOException) {
                // The writer closed the socket after its linger.
            }
        }

        private fun requestClose(code: Int) {
            if (closeCode.compareAndSet(0, code)) wakeWriter()
        }

        private fun wakeWriter() {
            writer?.let { LockSupport.unpark(it) }
        }

        private fun awaitEnd() {
            val until = System.nanoTime() + 2 * CLOSE_LINGER_NS
            while (!ended.get()) {
                val left = until - System.nanoTime()
                if (left <= 0) return
                LockSupport.parkNanos(this, left)
            }
        }

        private fun write() {
            Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_DISPLAY)
            val out = BufferedOutputStream(output, OUT_BUFFER)
            val tap = ByteBuffer.allocateDirect(NativeMics.TAP_MESSAGE_MAX)
            val tapBytes = ByteArray(NativeMics.TAP_MESSAGE_MAX)
            try {
                while (!ended.get()) {
                    val code = closeCode.get()
                    if (code != 0) return finish(out, code)
                    pong.getAndSet(null)?.let { WsFrames.write(out, WsFrames.OP_PONG, it) }
                    val moreTaps = drainTaps(out, tap, tapBytes)
                    val moreTexts = writeTexts(out, TEXT_BATCH)
                    out.flush()
                    if (!moreTaps && !moreTexts) LockSupport.parkNanos(this, TAP_PERIOD_NS)
                }
            } catch (_: IOException) {
                // The page went away, or the connection ended.
            } catch (e: RuntimeException) {
                Log.w(TAG, "voice door writer failed: ${e.javaClass.simpleName}")
            } finally {
                end()
            }
        }

        /** Sends the engine's waiting tap messages; true when it stopped with more possibly waiting. */
        private fun drainTaps(out: OutputStream, tap: ByteBuffer, bytes: ByteArray): Boolean {
            repeat(TAP_BATCH) {
                tap.clear()
                val size = synchronized(drainLock) { NativeMics.drainTap(tap) }
                if (size !in 1..bytes.size) return false
                tap.get(bytes, 0, size)
                WsFrames.write(out, WsFrames.OP_BINARY, bytes, 0, size)
            }
            return true
        }

        /** Sends up to [limit] queued messages; true when more are waiting. */
        private fun writeTexts(out: OutputStream, limit: Int): Boolean {
            repeat(limit) {
                val text = texts.poll() ?: return false
                queued.decrementAndGet()
                WsFrames.write(out, WsFrames.OP_TEXT, text)
            }
            return texts.isNotEmpty()
        }

        /** The closing handshake from this side: queued messages (unless they overflowed), the close frame, then a FIN. */
        private fun finish(out: OutputStream, code: Int) {
            if (!overflowed) {
                while (writeTexts(out, TEXT_BATCH)) Unit
            }
            WsFrames.write(out, WsFrames.OP_CLOSE, WsFrames.closePayload(code))
            out.flush()
            Log.i(TAG, "voice door closing the page connection: $code")
            socket.shutdownOutput()
            val until = System.nanoTime() + CLOSE_LINGER_NS
            while (!readerDone && !ended.get()) {
                val left = until - System.nanoTime()
                if (left <= 0) return
                LockSupport.parkNanos(this, left)
            }
        }
    }

    /** The socket's input with a deadline over a whole exchange, not just each read, while one is armed. */
    private class DeadlineInput(private val socket: Socket, private val raw: InputStream) : InputStream() {
        private var until = 0L

        fun arm(ms: Long) {
            until = System.nanoTime() + ms * NANOS_PER_MS
        }

        fun disarm() {
            if (until == 0L) return
            until = 0L
            socket.soTimeout = 0
        }

        override fun read(): Int {
            limit()
            return raw.read()
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            limit()
            return raw.read(b, off, len)
        }

        override fun available(): Int = raw.available()

        override fun close() = raw.close()

        private fun limit() {
            if (until == 0L) return
            val left = (until - System.nanoTime()) / NANOS_PER_MS
            if (left <= 0) throw SocketTimeoutException("deadline")
            socket.soTimeout = left.toInt()
        }
    }

    private fun closeQuietly(closeable: Closeable) {
        try {
            closeable.close()
        } catch (_: IOException) {
        }
    }

    companion object {
        const val JS_NAME = "FireSongVoice"
        private const val TAG = "FireSong"
        private const val LOOPBACK = "127.0.0.1"
        private const val PATH = "/voice"
        private const val MAX_HEAD = 8192
        private const val IN_BUFFER = 16384
        private const val OUT_BUFFER = NativeMics.TAP_MESSAGE_MAX + 16
        private const val DISCARD_BUFFER = 4096
        private const val NANOS_PER_MS = 1_000_000L
        private const val HANDSHAKE_TIMEOUT_MS = 2000L
        private const val HELLO_TIMEOUT_MS = 5000L
        private const val CLOSE_LINGER_NS = 1000 * NANOS_PER_MS
        private const val TAP_PERIOD_NS = 12 * NANOS_PER_MS
        private const val TEXT_QUEUE_MAX = 512
        private const val TEXT_BATCH = 64
        private const val TAP_BATCH = 8

        /** NativeMics.drainTap has one consumer process-wide; writers of old and new connections and doors overlap. */
        private val drainLock = Any()
    }
}
