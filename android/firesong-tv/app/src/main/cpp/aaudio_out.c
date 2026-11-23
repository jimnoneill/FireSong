// The voice output: one AAudio low-latency stream, its clock thread and its
// restart path, taken after an error, a disconnect, or a started stream whose
// callbacks stopped.
//
// The data callback renders and counts frames, nothing else. Every other
// AAudio call (open, close, getTimestamp, setBufferSizeInFrames, the xrun
// count) runs under ao_lock, on the caller of ao_open/ao_close or on the
// fsv-clock thread, which also reopens the stream after an error or a failed
// open. The error callback only raises a flag for that thread.
#include <aaudio/AAudio.h>
#include <android/log.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

#include "fsv_api.h"

#define TAG "FireSongVoice"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define LOGW(...) __android_log_print(ANDROID_LOG_WARN, TAG, __VA_ARGS__)

#define CHANNELS 2
#define CAPACITY_FRAMES (4 * 480)
#define MIN_BURSTS 2
#define MAX_BURSTS 4
#define NS_MS(ms) ((int64_t)(ms) * 1000000LL)
#define TICK_NS NS_MS(50)
#define REOPEN_NS NS_MS(200)
#define RETRY_FIRST_NS NS_MS(2000)
#define RETRY_MAX_NS NS_MS(10000)
#define SHRINK_AFTER_NS NS_MS(120000)
#define SETTLE_NS NS_MS(500)
#define STALL_TICKS 20
#define STOP_WAIT_NS NS_MS(200)

static pthread_mutex_t ao_lock = PTHREAD_MUTEX_INITIALIZER;
static AAudioStream *stream;
static fsv_render_fn render_fn;
static pthread_t clock_thread;
static int clock_started;
static intptr_t last_stream_id;
static int64_t next_open_ns, retry_ns, last_xrun_ns, xruns_closed, settle_until_ns, last_published;
static int32_t burst, stream_xruns, stall_ticks;

static _Atomic int wanted, need_restart;
static _Atomic intptr_t stream_id;
static _Atomic int last_error;

/* Callback thread only; reset before each stream starts. */
static int64_t frames_rendered;
static _Atomic int64_t frames_published;

static _Atomic int64_t st_burst, st_buffer, st_xruns, st_latency_us = -1, st_restarts, st_open, st_attempts;

/* The latest timestamp, behind a seqlock: written under ao_lock, read by the callback. */
static _Atomic uint32_t ts_seq;
static _Atomic int ts_valid;
static _Atomic int64_t ts_frame, ts_time;

static int64_t now_ns(void) {
  struct timespec ts;
  clock_gettime(CLOCK_MONOTONIC, &ts);
  return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static void publish_timestamp(int valid, int64_t frame, int64_t time) {
  uint32_t seq = atomic_load_explicit(&ts_seq, memory_order_relaxed);
  atomic_store_explicit(&ts_seq, seq + 1, memory_order_relaxed);
  atomic_thread_fence(memory_order_release);
  atomic_store_explicit(&ts_valid, valid, memory_order_relaxed);
  atomic_store_explicit(&ts_frame, frame, memory_order_relaxed);
  atomic_store_explicit(&ts_time, time, memory_order_relaxed);
  atomic_store_explicit(&ts_seq, seq + 2, memory_order_release);
}

int ao_presentation_ns(int64_t frame_index, int64_t *t_ns) {
  for (int attempt = 0; attempt < 4; attempt++) {
    uint32_t seq = atomic_load_explicit(&ts_seq, memory_order_acquire);
    if (seq & 1u) continue;
    int valid = atomic_load_explicit(&ts_valid, memory_order_relaxed);
    int64_t frame = atomic_load_explicit(&ts_frame, memory_order_relaxed);
    int64_t time = atomic_load_explicit(&ts_time, memory_order_relaxed);
    atomic_thread_fence(memory_order_acquire);
    if (atomic_load_explicit(&ts_seq, memory_order_relaxed) != seq) continue;
    if (!valid) return FSV_ERR_STATE;
    *t_ns = time + (frame_index - frame) * 1000000000LL / FSV_RATE;
    return FSV_OK;
  }
  return FSV_ERR_STATE;
}

static aaudio_data_callback_result_t on_audio(AAudioStream *s, void *user, void *audio, int32_t frames) {
  (void)s;
  (void)user;
  render_fn(audio, frames, frames_rendered);
  frames_rendered += frames;
  atomic_store_explicit(&frames_published, frames_rendered, memory_order_relaxed);
  return AAUDIO_CALLBACK_RESULT_CONTINUE;
}

static void on_error(AAudioStream *s, void *user, aaudio_result_t error) {
  (void)s;
  if ((intptr_t)user != atomic_load(&stream_id)) return;
  atomic_store(&last_error, error);
  atomic_store(&need_restart, 1);
}

static void close_locked(void) {
  if (stream == NULL) return;
  atomic_store(&stream_id, 0);
  if (AAudioStream_requestStop(stream) == AAUDIO_OK) {
    aaudio_stream_state_t state = AAUDIO_STREAM_STATE_UNKNOWN;
    AAudioStream_waitForStateChange(stream, AAUDIO_STREAM_STATE_STOPPING, &state, STOP_WAIT_NS);
  }
  AAudioStream_close(stream);
  stream = NULL;
  xruns_closed += stream_xruns;
  stream_xruns = 0;
  publish_timestamp(0, 0, 0);
  atomic_store(&st_open, 0);
  atomic_store(&st_latency_us, -1);
}

static int open_locked(void) {
  atomic_fetch_add(&st_attempts, 1);
  AAudioStreamBuilder *builder = NULL;
  aaudio_result_t result = AAudio_createStreamBuilder(&builder);
  if (result != AAUDIO_OK) {
    LOGW("builder failed: %s", AAudio_convertResultToText(result));
    return 0;
  }
  intptr_t id = last_stream_id = last_stream_id >= INTPTR_MAX ? 1 : last_stream_id + 1;
  AAudioStreamBuilder_setDirection(builder, AAUDIO_DIRECTION_OUTPUT);
  AAudioStreamBuilder_setPerformanceMode(builder, AAUDIO_PERFORMANCE_MODE_LOW_LATENCY);
  AAudioStreamBuilder_setSharingMode(builder, AAUDIO_SHARING_MODE_SHARED);
  AAudioStreamBuilder_setSampleRate(builder, FSV_RATE);
  AAudioStreamBuilder_setChannelCount(builder, CHANNELS);
  AAudioStreamBuilder_setFormat(builder, AAUDIO_FORMAT_PCM_I16);
  AAudioStreamBuilder_setUsage(builder, AAUDIO_USAGE_MEDIA);
  AAudioStreamBuilder_setContentType(builder, AAUDIO_CONTENT_TYPE_MUSIC);
  AAudioStreamBuilder_setBufferCapacityInFrames(builder, CAPACITY_FRAMES);
  AAudioStreamBuilder_setDataCallback(builder, on_audio, (void *)id);
  AAudioStreamBuilder_setErrorCallback(builder, on_error, (void *)id);
  AAudioStream *opened = NULL;
  result = AAudioStreamBuilder_openStream(builder, &opened);
  AAudioStreamBuilder_delete(builder);
  if (result != AAUDIO_OK) {
    LOGW("open failed: %s", AAudio_convertResultToText(result));
    return 0;
  }
  if (AAudioStream_getSampleRate(opened) != FSV_RATE || AAudioStream_getChannelCount(opened) != CHANNELS ||
      AAudioStream_getFormat(opened) != AAUDIO_FORMAT_PCM_I16) {
    LOGW("unexpected stream: %d Hz, %d ch, format %d", AAudioStream_getSampleRate(opened),
         AAudioStream_getChannelCount(opened), AAudioStream_getFormat(opened));
    AAudioStream_close(opened);
    return 0;
  }
  burst = AAudioStream_getFramesPerBurst(opened);
  if (burst > 0) AAudioStream_setBufferSizeInFrames(opened, burst * MIN_BURSTS);
  frames_rendered = 0;
  atomic_store(&frames_published, 0);
  publish_timestamp(0, 0, 0);
  atomic_store(&need_restart, 0);
  atomic_store(&stream_id, id);
  result = AAudioStream_requestStart(opened);
  if (result != AAUDIO_OK) {
    LOGW("start failed: %s", AAudio_convertResultToText(result));
    atomic_store(&stream_id, 0);
    AAudioStream_close(opened);
    return 0;
  }
  stream = opened;
  stream_xruns = 0;
  last_xrun_ns = now_ns();
  settle_until_ns = last_xrun_ns + SETTLE_NS;
  last_published = 0;
  stall_ticks = 0;
  atomic_store(&st_burst, burst);
  atomic_store(&st_buffer, AAudioStream_getBufferSizeInFrames(opened));
  atomic_store(&st_open, 1);
  LOGI("open: perf %d, sharing %d, burst %d, buffer %d/%d", AAudioStream_getPerformanceMode(opened),
       AAudioStream_getSharingMode(opened), burst, AAudioStream_getBufferSizeInFrames(opened),
       AAudioStream_getBufferCapacityInFrames(opened));
  return 1;
}

/*
 * After an xrun one burst more buffer, up to MAX_BURSTS; after SHRINK_AFTER_NS without one, a burst less. Xruns
 * in the first SETTLE_NS of a stream come from its start, not its buffer: they are counted but change nothing.
 */
static void tune_buffer_locked(int64_t now) {
  int32_t xruns = AAudioStream_getXRunCount(stream);
  if (xruns < 0 || burst <= 0) return;
  int32_t size = AAudioStream_getBufferSizeInFrames(stream);
  int32_t wanted_size = size;
  if (xruns > stream_xruns) {
    stream_xruns = xruns;
    if (now >= settle_until_ns) {
      last_xrun_ns = now;
      if (size < burst * MAX_BURSTS) wanted_size = size + burst;
    }
  } else if (now - last_xrun_ns >= SHRINK_AFTER_NS) {
    last_xrun_ns = now;
    if (size > burst * MIN_BURSTS) wanted_size = size - burst;
  }
  if (wanted_size != size) {
    int32_t set = AAudioStream_setBufferSizeInFrames(stream, wanted_size);
    if (set > 0) {
      atomic_store(&st_buffer, set);
      LOGI("buffer %d -> %d frames (xruns %d)", size, set, xruns);
    }
  }
  atomic_store(&st_xruns, xruns_closed + stream_xruns);
}

static void clock_tick_locked(void) {
  int64_t frame = 0, time = 0;
  if (AAudioStream_getTimestamp(stream, CLOCK_MONOTONIC, &frame, &time) == AAUDIO_OK) {
    publish_timestamp(1, frame, time);
    int64_t rendered = atomic_load_explicit(&frames_published, memory_order_relaxed);
    int64_t present = time + (rendered - frame) * 1000000000LL / FSV_RATE;
    atomic_store(&st_latency_us, (present - now_ns()) / 1000);
  }
  tune_buffer_locked(now_ns());
}

/* True once a started stream that has rendered renders nothing more for STALL_TICKS ticks. */
static int stalled_locked(aaudio_stream_state_t state) {
  int64_t published = atomic_load_explicit(&frames_published, memory_order_relaxed);
  if (published != last_published || published == 0 || state != AAUDIO_STREAM_STATE_STARTED) {
    last_published = published;
    stall_ticks = 0;
    return 0;
  }
  return ++stall_ticks >= STALL_TICKS;
}

static void *clock_main(void *arg) {
  (void)arg;
  pthread_setname_np(pthread_self(), "fsv-clock");
  const struct timespec tick = {0, TICK_NS};
  while (atomic_load(&wanted)) {
    clock_nanosleep(CLOCK_MONOTONIC, 0, &tick, NULL);
    pthread_mutex_lock(&ao_lock);
    if (!atomic_load(&wanted)) {
      pthread_mutex_unlock(&ao_lock);
      break;
    }
    int64_t now = now_ns();
    int lost = stream != NULL && atomic_exchange(&need_restart, 0);
    int stalled = 0;
    if (stream != NULL && !lost) {
      aaudio_stream_state_t state = AAudioStream_getState(stream);
      if (state == AAUDIO_STREAM_STATE_DISCONNECTED) {
        atomic_store(&last_error, AAUDIO_ERROR_DISCONNECTED);
        lost = 1;
      } else {
        lost = stalled = stalled_locked(state);
      }
    }
    if (lost) {
      LOGW("stream lost (%s): reopening",
           stalled ? "no callbacks" : AAudio_convertResultToText(atomic_load(&last_error)));
      close_locked();
      atomic_fetch_add(&st_restarts, 1);
      next_open_ns = now + REOPEN_NS;
      retry_ns = RETRY_FIRST_NS;
    }
    if (stream == NULL && now >= next_open_ns) {
      if (open_locked()) {
        retry_ns = RETRY_FIRST_NS;
      } else {
        next_open_ns = now + retry_ns;
        retry_ns = retry_ns * 2 > RETRY_MAX_NS ? RETRY_MAX_NS : retry_ns * 2;
      }
    }
    if (stream != NULL) clock_tick_locked();
    pthread_mutex_unlock(&ao_lock);
  }
  return NULL;
}

int ao_open(fsv_render_fn render) {
  pthread_mutex_lock(&ao_lock);
  if (atomic_load(&wanted)) {
    int open = stream != NULL;
    pthread_mutex_unlock(&ao_lock);
    return open ? FSV_OK : FSV_ERR_AUDIO;
  }
  render_fn = render;
  atomic_store(&last_error, AAUDIO_OK);
  atomic_store(&st_attempts, 0);
  atomic_store(&st_restarts, 0);
  atomic_store(&st_xruns, 0);
  atomic_store(&st_burst, 0);
  atomic_store(&st_buffer, 0);
  xruns_closed = 0;
  int open = open_locked();
  if (!open) {
    next_open_ns = now_ns() + RETRY_FIRST_NS;
    retry_ns = RETRY_FIRST_NS * 2;
    LOGW("audio pending: retrying");
  }
  atomic_store(&wanted, 1);
  if (pthread_create(&clock_thread, NULL, clock_main, NULL) != 0) {
    atomic_store(&wanted, 0);
    close_locked();
    pthread_mutex_unlock(&ao_lock);
    return FSV_ERR_STATE;
  }
  clock_started = 1;
  pthread_mutex_unlock(&ao_lock);
  return open ? FSV_OK : FSV_ERR_AUDIO;
}

void ao_close(void) {
  pthread_mutex_lock(&ao_lock);
  atomic_store(&wanted, 0);
  close_locked();
  int join = clock_started;
  clock_started = 0;
  pthread_mutex_unlock(&ao_lock);
  if (join) pthread_join(clock_thread, NULL);
}

void ao_stats(int64_t *burst_frames, int64_t *buffer, int64_t *xruns, int64_t *latency_us, int64_t *restarts,
              int64_t *open) {
  *burst_frames = atomic_load(&st_burst);
  *buffer = atomic_load(&st_buffer);
  *xruns = atomic_load(&st_xruns);
  *latency_us = atomic_load(&st_latency_us);
  *restarts = atomic_load(&st_restarts);
  *open = atomic_load(&st_open);
}

int64_t ao_open_attempts(void) { return atomic_load(&st_attempts); }
