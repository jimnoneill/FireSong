package org.firesong.tv

import android.os.Process
import android.util.Base64
import android.util.Log
import android.webkit.JavascriptInterface
import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.security.MessageDigest
import java.security.SecureRandom
import org.json.JSONObject

/**
 * The page's way into [NativeVoice]: a WebSocket on 127.0.0.1 that the TV
 * page's voice worker connects to, with a per-launch token in the path and
 * the TV origin checked. The page reads the address from
 * `window.FireSongVoice.endpoint()`. One connection at a time: a new one
 * replaces the old. The native stream runs only while a page is connected.
 */
class VoiceDoor(private val allowedOrigin: () -> String?) {
    private val token = ByteArray(16).also { SecureRandom().nextBytes(it) }.joinToString("") { "%02x".format(it) }

    @Volatile private var server: ServerSocket? = null
    @Volatile private var client: Socket? = null
    @Volatile private var connections = 0

    fun open() {
        if (!NativeVoice.available || server != null) return
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

    fun close() {
        server?.let { closeQuietly(it) }
        server = null
        client?.let { closeQuietly(it) }
        client = null
        NativeVoice.stop()
    }

    fun endpoint(): String {
        val socket = server ?: return ""
        return JSONObject().apply {
            put("version", 1)
            put("url", "ws://$LOOPBACK:${socket.localPort}$PATH?t=$token")
            put("rate", NativeVoice.RATE)
            put("channels", NativeVoice.CHANNELS)
            put("format", "s16le")
        }.toString()
    }

    fun stats(): String {
        val v = LongArray(14)
        NativeVoice.stats(v)
        val framesPerMs = NativeVoice.RATE / 1000.0
        return JSONObject().apply {
            put("open", v[0] == 1L)
            put("connected", client != null)
            put("connections", connections)
            put("playedFrames", v[1])
            put("underruns", v[2])
            put("trimmedFrames", v[3])
            put("overflowFrames", v[4])
            put("receivedFrames", v[5])
            put("fillMs", v[6] / framesPerMs)
            put("marginMs", v[7] / framesPerMs)
            put("outputLatencyMs", if (v[8] < 0) JSONObject.NULL else v[8] / 1000.0)
            put("burstFrames", v[9])
            put("bufferFrames", v[10])
            put("xruns", v[11])
            put("peak", v[13] / 32768.0)
        }.toString()
    }

    /** `window.FireSongVoice` for the page. */
    class Js(private val door: VoiceDoor) {
        @JavascriptInterface
        fun endpoint(): String = door.endpoint()

        @JavascriptInterface
        fun stats(): String = door.stats()
    }

    private fun accept(socket: ServerSocket) {
        while (!socket.isClosed) {
            val incoming = try {
                socket.accept()
            } catch (_: IOException) {
                break
            }
            Thread({ serve(incoming) }, "fs-voice-in").apply { isDaemon = true }.start()
        }
    }

    private fun serve(socket: Socket) {
        Process.setThreadPriority(Process.THREAD_PRIORITY_URGENT_AUDIO)
        try {
            socket.tcpNoDelay = true
            socket.soTimeout = HANDSHAKE_TIMEOUT_MS
            val input = BufferedInputStream(socket.getInputStream(), 16384)
            val output = socket.getOutputStream()
            val accept = handshake(input) ?: return reject(output, "403 Forbidden")
            client?.let { closeQuietly(it) }
            client = socket
            connections += 1
            if (!NativeVoice.start()) return reject(output, "503 Service Unavailable")
            output.write(
                ("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
                    "Sec-WebSocket-Accept: $accept\r\n\r\n").toByteArray(Charsets.US_ASCII),
            )
            output.flush()
            socket.soTimeout = 0
            Log.i(TAG, "voice page connected")
            frames(input, output)
        } catch (_: IOException) {
            // The page went away or the door closed.
        } finally {
            closeQuietly(socket)
            if (client === socket) {
                client = null
                NativeVoice.stop()
                Log.i(TAG, "voice page disconnected")
            }
        }
    }

    /** Checks the upgrade request; returns `Sec-WebSocket-Accept`, or null to refuse. */
    private fun handshake(input: InputStream): String? {
        val lines = readHead(input) ?: return null
        val request = lines.first().split(' ')
        if (request.size != 3 || request[0] != "GET" || request[1] != "$PATH?t=$token") return null
        val headers = lines.drop(1).mapNotNull { line ->
            val colon = line.indexOf(':')
            if (colon <= 0) null else line.substring(0, colon).trim().lowercase() to line.substring(colon + 1).trim()
        }.toMap()
        if (!headers["upgrade"].equals("websocket", ignoreCase = true)) return null
        val origin = allowedOrigin()
        if (origin == null || headers["origin"] != origin) return null
        val key = headers["sec-websocket-key"] ?: return null
        val digest = MessageDigest.getInstance("SHA-1").digest((key + WS_GUID).toByteArray(Charsets.US_ASCII))
        return Base64.encodeToString(digest, Base64.NO_WRAP)
    }

    private fun readHead(input: InputStream): List<String>? {
        val head = StringBuilder()
        while (head.length < MAX_HEAD) {
            val b = input.read()
            if (b < 0) return null
            head.append(b.toChar())
            if (head.endsWith("\r\n\r\n")) return head.trimEnd().split("\r\n")
        }
        return null
    }

    /** Client frames are masked; binary payloads are the voice, s16le stereo. */
    private fun frames(input: InputStream, output: OutputStream) {
        val payload = ByteArray(MAX_PAYLOAD)
        val audio = ByteBuffer.allocateDirect(MAX_PAYLOAD)
        val mask = ByteArray(4)
        while (true) {
            val b0 = readByte(input)
            val b1 = readByte(input)
            val opcode = b0 and 0x0f
            if (b1 and 0x80 == 0) return close(output, 1002)
            var length = (b1 and 0x7f).toLong()
            if (length == 126L) {
                length = ((readByte(input) shl 8) or readByte(input)).toLong()
            } else if (length == 127L) {
                length = 0
                repeat(8) { length = (length shl 8) or readByte(input).toLong() }
            }
            if (length > MAX_PAYLOAD) return close(output, 1009)
            readFully(input, mask, 4)
            val size = length.toInt()
            readFully(input, payload, size)
            for (i in 0 until size) payload[i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
            when (opcode) {
                OP_BINARY -> {
                    audio.clear()
                    audio.put(payload, 0, size)
                    NativeVoice.write(audio, size)
                }
                OP_CLOSE -> return close(output, 1000)
                OP_PING -> send(output, OP_PONG, payload, size)
            }
        }
    }

    private fun readByte(input: InputStream): Int {
        val b = input.read()
        if (b < 0) throw IOException("closed")
        return b
    }

    private fun readFully(input: InputStream, into: ByteArray, size: Int) {
        var read = 0
        while (read < size) {
            val n = input.read(into, read, size - read)
            if (n < 0) throw IOException("closed")
            read += n
        }
    }

    /** Control frames only: their payload is at most 125 bytes. */
    private fun send(output: OutputStream, opcode: Int, data: ByteArray, size: Int) {
        val length = minOf(size, MAX_CONTROL_PAYLOAD)
        output.write(byteArrayOf((0x80 or opcode).toByte(), length.toByte()))
        output.write(data, 0, length)
        output.flush()
    }

    private fun close(output: OutputStream, code: Int) {
        send(output, OP_CLOSE, byteArrayOf((code shr 8).toByte(), code.toByte()), 2)
    }

    private fun reject(output: OutputStream, status: String) {
        output.write("HTTP/1.1 $status\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".toByteArray(Charsets.US_ASCII))
        output.flush()
    }

    private fun closeQuietly(closeable: java.io.Closeable) {
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
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
        private const val MAX_HEAD = 8192
        private const val HANDSHAKE_TIMEOUT_MS = 2000
        private const val MAX_CONTROL_PAYLOAD = 125
        private const val MAX_PAYLOAD = 65536
        private const val OP_BINARY = 0x2
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xA
    }
}
