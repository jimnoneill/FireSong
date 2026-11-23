// FireSong TV voice output: the page's voice mix, played through AAudio's
// low-latency path. On the Fire TV Cube that path measured 31 ms against
// 256 ms for the WebView's own output (OpenSL ES on the normal HDMI mixer).
//
// One producer (VoiceDoor's socket thread) writes interleaved stereo s16
// frames into a ring; the AAudio callback reads them. The ring keeps only as
// much audio as the page's delivery needs: it trims the slack it never used
// (in a quiet moment, so the jump is inaudible) and grows its margin after an
// underrun.
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <jni.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define TAG "FireSongVoice"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

#define RATE 48000
#define CHANNELS 2
#define RING_FRAMES 32768 // 683 ms; a power of two
#define RING_MASK (RING_FRAMES - 1)
#define FRAMES_MS(ms) ((int64_t)(ms) * RATE / 1000)

// Margin: the lowest fill the ring keeps. Starts small, +6 ms per underrun,
// -1 ms after every 5 s without one.
#define MARGIN_START FRAMES_MS(8)
#define MARGIN_MIN FRAMES_MS(6)
#define MARGIN_MAX FRAMES_MS(80)
#define MARGIN_STEP FRAMES_MS(6)
#define MARGIN_DECAY FRAMES_MS(1)
#define CLEAN_WINDOWS_FOR_DECAY 5
// After an underrun, wait for margin + this much before playing again.
#define PRIME_EXTRA FRAMES_MS(24)
// The fill is judged over 1 s windows; slack over 4 ms is trimmed.
#define WINDOW_FRAMES RATE
#define TRIM_MIN FRAMES_MS(4)
// About -40 dBFS: skipping audio this quiet is inaudible.
#define QUIET 328

static int16_t ring[RING_FRAMES * CHANNELS];
static _Atomic int64_t written; // frames; written by the producer only
static _Atomic int64_t readpos; // frames; written by the callback only

static pthread_mutex_t stream_lock = PTHREAD_MUTEX_INITIALIZER;
static AAudioStream *stream;
static _Atomic int restarting;

// Audio-thread state.
static int64_t margin = MARGIN_START;
static int priming = 1;
static int64_t window_min = INT64_MAX;
static int64_t window_frames;
static int clean_windows;
static int64_t pending_trim;
static int window_underruns;

// Counters for stats().
static _Atomic int64_t played, underruns, trimmed, overflows, received;
static _Atomic int64_t stat_fill, stat_margin;
static _Atomic int peak; // largest |sample| played since the last stats()

static int64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static int quiet_span(int64_t from, int64_t frames) {
  for (int64_t f = 0; f < frames; f++) {
    const int16_t *frame = &ring[((from + f) & RING_MASK) * CHANNELS];
    for (int c = 0; c < CHANNELS; c++) {
      int v = frame[c];
      if (v > QUIET || v < -QUIET) return 0;
    }
  }
  return 1;
}

static void end_window(int64_t fill) {
  if (window_underruns == 0) {
    if (++clean_windows >= CLEAN_WINDOWS_FOR_DECAY) {
      clean_windows = 0;
      margin = margin - MARGIN_DECAY < MARGIN_MIN ? MARGIN_MIN : margin - MARGIN_DECAY;
    }
    int64_t slack = window_min - margin;
    pending_trim = slack > TRIM_MIN ? slack : 0;
  } else {
    clean_windows = 0;
    pending_trim = 0;
  }
  (void)fill;
  window_min = INT64_MAX;
  window_frames = 0;
  window_underruns = 0;
}

static aaudio_data_callback_result_t on_audio(AAudioStream *s, void *user, void *audio, int32_t frames) {
  (void)s;
  (void)user;
  int16_t *out = audio;
  int64_t w = atomic_load_explicit(&written, memory_order_acquire);
  int64_t r = atomic_load_explicit(&readpos, memory_order_relaxed);
  int64_t fill = w - r;
  if (fill < 0 || fill > RING_FRAMES) { // cannot happen; recover anyway
    r = w;
    fill = 0;
  }

  if (priming) {
    if (fill < margin + PRIME_EXTRA) {
      memset(out, 0, (size_t)frames * CHANNELS * sizeof(int16_t));
      atomic_store_explicit(&stat_fill, fill, memory_order_relaxed);
      atomic_store_explicit(&readpos, r, memory_order_release);
      return AAUDIO_CALLBACK_RESULT_CONTINUE;
    }
    priming = 0;
    window_min = INT64_MAX;
    window_frames = 0;
  }

  if (pending_trim > 0 && fill - pending_trim >= frames) {
    if (quiet_span(r, pending_trim)) {
      r += pending_trim;
      fill -= pending_trim;
      atomic_fetch_add_explicit(&trimmed, pending_trim, memory_order_relaxed);
      pending_trim = 0;
    }
  }

  int64_t n = fill < frames ? fill : frames;
  int loudest = 0;
  for (int64_t f = 0; f < n; f++) {
    const int16_t *frame = &ring[((r + f) & RING_MASK) * CHANNELS];
    memcpy(&out[f * CHANNELS], frame, CHANNELS * sizeof(int16_t));
    for (int c = 0; c < CHANNELS; c++) {
      int v = frame[c] < 0 ? -frame[c] : frame[c];
      if (v > loudest) loudest = v;
    }
  }
  if (loudest > atomic_load_explicit(&peak, memory_order_relaxed)) {
    atomic_store_explicit(&peak, loudest, memory_order_relaxed);
  }
  if (n < frames) {
    memset(&out[n * CHANNELS], 0, (size_t)(frames - n) * CHANNELS * sizeof(int16_t));
    atomic_fetch_add_explicit(&underruns, 1, memory_order_relaxed);
    window_underruns++;
    margin = margin + MARGIN_STEP > MARGIN_MAX ? MARGIN_MAX : margin + MARGIN_STEP;
    priming = 1;
  }
  r += n;
  fill -= n;
  atomic_store_explicit(&readpos, r, memory_order_release);
  atomic_fetch_add_explicit(&played, n, memory_order_relaxed);

  if (fill < window_min) window_min = fill;
  window_frames += frames;
  if (window_frames >= WINDOW_FRAMES) end_window(fill);
  atomic_store_explicit(&stat_fill, fill, memory_order_relaxed);
  atomic_store_explicit(&stat_margin, margin, memory_order_relaxed);
  return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

static void close_locked(void) {
  if (stream == NULL) return;
  AAudioStream_requestStop(stream);
  AAudioStream_close(stream);
  stream = NULL;
}

static void on_error(AAudioStream *s, void *user, aaudio_result_t error);

static int open_locked(void) {
  if (stream != NULL) return 1;
  AAudioStreamBuilder *builder = NULL;
  if (AAudio_createStreamBuilder(&builder) != AAUDIO_OK) return 0;
  AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
  AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
  AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
  AAudioStreamBuilder_setSampleRate(builder, RATE);
  AAudioStreamBuilder_setChannelCount(builder, CHANNELS);
  AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
  AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_MEDIA);
  AAudioStreamBuilder_setContentType(builder, AAUDIO_CONTENT_TYPE_MUSIC);
  AAudioStreamBuilder_setDataCallback(builder, on_audio, NULL);
  AAudioStreamBuilder_setErrorCallback(builder, on_error, NULL);
  AAudioStream *opened = NULL;
  aaudio_result_t result = AAudioStreamBuilder_openStream(builder, &opened);
  AAudioStreamBuilder_delete(builder);
  if (result != AAUDIO_OK) {
    LOGW("open failed: %s", AAudio_convertResultToText(result));
    return 0;
  }
  if (AAudioStream_getSampleRate(opened) != RATE || AAudioStream_getChannelCount(opened) != CHANNELS ||
      AAudioStream_getFormat(opened) != AAUDIO_FORMAT_PCM_I16) {
    LOGW("unexpected stream: %d Hz, %d ch, format %d", AAudioStream_getSampleRate(opened),
         AAudioStream_getChannelCount(opened), AAudioStream_getFormat(opened));
    AAudioStream_close(opened);
    return 0;
  }
  int32_t burst = AAudioStream_getFramesPerBurst(opened);
  AAudioStream_setBufferSizeInFrames(opened, burst * 2);
  // Nothing old is played: start from what arrives next.
  atomic_store_explicit(&readpos, atomic_load_explicit(&written, memory_order_acquire), memory_order_release);
  priming = 1;
  margin = MARGIN_START;
  window_min = INT64_MAX;
  window_frames = 0;
  clean_windows = 0;
  pending_trim = 0;
  window_underruns = 0;
  result = AAudioStream_requestStart(opened);
  if (result != AAUDIO_OK) {
    LOGW("start failed: %s", AAudio_convertResultToText(result));
    AAudioStream_close(opened);
    return 0;
  }
  stream = opened;
  LOGI("open: perf %d, sharing %d, burst %d, buffer %d/%d", AAudioStream_getPerformanceMode(opened),
       AAudioStream_getSharingMode(opened), burst, AAudioStream_getBufferSizeInFrames(opened),
       AAudioStream_getBufferCapacityInFrames(opened));
  return 1;
}

static void *restart_thread(void *arg) {
  (void)arg;
  pthread_mutex_lock(&stream_lock);
  close_locked();
  usleep(200000);
  int ok = open_locked();
  pthread_mutex_unlock(&stream_lock);
  LOGI("restart after disconnect: %s", ok ? "ok" : "failed");
  atomic_store(&restarting, 0);
  return NULL;
}

// AAudio calls this on its own thread; the stream must not be reopened here.
static void on_error(AAudioStream *s, void *user, aaudio_result_t error) {
  (void)s;
  (void)user;
  LOGW("stream error: %s", AAudio_convertResultToText(error));
  if (error != AAUDIO_ERROR_DISCONNECTED) return;
  int expected = 0;
  if (!atomic_compare_exchange_strong(&restarting, &expected, 1)) return;
  pthread_t thread;
  if (pthread_create(&thread, NULL, restart_thread, NULL) == 0) {
    pthread_detach(thread);
  } else {
    atomic_store(&restarting, 0);
  }
}

JNIEXPORT jboolean JNICALL Java_org_firesong_tv_NativeVoice_start(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  pthread_mutex_lock(&stream_lock);
  int ok = open_locked();
  pthread_mutex_unlock(&stream_lock);
  return ok ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeVoice_stop(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  pthread_mutex_lock(&stream_lock);
  close_locked();
  pthread_mutex_unlock(&stream_lock);
}

// `bytes` of interleaved stereo s16le from a direct ByteBuffer. Returns the
// frames taken; when the ring is full the newest frames are dropped.
JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeVoice_write(JNIEnv *env, jclass cls, jobject buffer, jint bytes) {
  (void)cls;
  const int16_t *src = (*env)->GetDirectBufferAddress(env, buffer);
  if (src == NULL || bytes <= 0) return 0;
  int64_t frames = bytes / (CHANNELS * (int)sizeof(int16_t));
  int64_t w = atomic_load_explicit(&written, memory_order_relaxed);
  int64_t r = atomic_load_explicit(&readpos, memory_order_acquire);
  int64_t space = RING_FRAMES - (w - r);
  if (frames > space) {
    atomic_fetch_add_explicit(&overflows, frames - space, memory_order_relaxed);
    frames = space < 0 ? 0 : space;
  }
  for (int64_t f = 0; f < frames; f++) {
    memcpy(&ring[((w + f) & RING_MASK) * CHANNELS], &src[f * CHANNELS], CHANNELS * sizeof(int16_t));
  }
  atomic_store_explicit(&written, w + frames, memory_order_release);
  atomic_fetch_add_explicit(&received, frames, memory_order_relaxed);
  return (jint)frames;
}

// out[0..13]: open, played, underruns, trimmed, overflows, received (frames),
// fill, margin (frames), output latency (us, -1 unknown), burst, buffer size,
// xruns, sample rate, peak |sample| played since the previous call.
JNIEXPORT void JNICALL Java_org_firesong_tv_NativeVoice_stats(JNIEnv *env, jclass cls, jlongArray out) {
  (void)cls;
  jlong values[14] = {0};
  values[1] = atomic_load(&played);
  values[2] = atomic_load(&underruns);
  values[3] = atomic_load(&trimmed);
  values[4] = atomic_load(&overflows);
  values[5] = atomic_load(&received);
  values[6] = atomic_load(&stat_fill);
  values[7] = atomic_load(&stat_margin);
  values[8] = -1;
  values[13] = atomic_exchange(&peak, 0);
  pthread_mutex_lock(&stream_lock);
  if (stream != NULL) {
    values[0] = 1;
    int64_t position = 0, time = 0;
    if (AAudioStream_getTimestamp(stream, CLOCK_MONOTONIC, &position, &time) == AAUDIO_OK) {
      int64_t ahead = AAudioStream_getFramesWritten(stream) - position;
      int64_t present = time + ahead * 1000000000LL / RATE;
      values[8] = (present - now_ns()) / 1000;
    }
    values[9] = AAudioStream_getFramesPerBurst(stream);
    values[10] = AAudioStream_getBufferSizeInFrames(stream);
    values[11] = AAudioStream_getXRunCount(stream);
    values[12] = AAudioStream_getSampleRate(stream);
  }
  pthread_mutex_unlock(&stream_lock);
  jsize length = (*env)->GetArrayLength(env, out);
  (*env)->SetLongArrayRegion(env, out, 0, length < 14 ? length : 14, values);
}
