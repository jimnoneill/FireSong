// JNI for org.firesong.tv.NativeMics: one entry per external function, each
// mapped to its fsv_* call. The engine's locks are released before any call
// back into the JVM (the array writes below).
#include <jni.h>
#include <stdint.h>

#include "fsv_api.h"

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_abi(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  return FSV_ABI;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_start(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  return fsv_start();
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_stop(JNIEnv *env, jclass cls, jint token) {
  (void)env;
  (void)cls;
  fsv_stop(token);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_attach(JNIEnv *env, jclass cls, jint slot, jint gen) {
  (void)env;
  (void)cls;
  fsv_attach(slot, gen);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_detach(JNIEnv *env, jclass cls, jint slot, jint gen) {
  (void)env;
  (void)cls;
  fsv_detach(slot, gen);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_release(JNIEnv *env, jclass cls, jint slot) {
  (void)env;
  (void)cls;
  fsv_release(slot);
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_push(JNIEnv *env, jclass cls, jint slot, jint gen, jobject pcm,
                                                            jint frames, jint rate, jint channels) {
  (void)cls;
  if (pcm == NULL || frames <= 0 || channels <= 0) return FSV_ERR_ARG;
  const int16_t *samples = (*env)->GetDirectBufferAddress(env, pcm);
  jlong capacity = (*env)->GetDirectBufferCapacity(env, pcm);
  if (samples == NULL || capacity < (jlong)frames * channels * (jlong)sizeof(int16_t)) return FSV_ERR_ARG;
  return fsv_push(slot, gen, samples, frames, rate, channels);
}

JNIEXPORT jboolean JNICALL Java_org_firesong_tv_NativeMics_set(JNIEnv *env, jclass cls, jint slot, jint control,
                                                               jfloat value) {
  (void)env;
  (void)cls;
  return fsv_set(slot, control, value) == FSV_OK ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jboolean JNICALL Java_org_firesong_tv_NativeMics_setEchoMix(JNIEnv *env, jclass cls, jfloat wet,
                                                                      jfloat feedback, jfloat lowpass_hz,
                                                                      jfloat reverb_send) {
  (void)env;
  (void)cls;
  return fsv_set_echo_mix(wet, feedback, lowpass_hz, reverb_send) == FSV_OK ? JNI_TRUE : JNI_FALSE;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_drainTap(JNIEnv *env, jclass cls, jobject out) {
  (void)cls;
  if (out == NULL) return 0;
  uint8_t *bytes = (*env)->GetDirectBufferAddress(env, out);
  jlong capacity = (*env)->GetDirectBufferCapacity(env, out);
  if (bytes == NULL || capacity <= 0) return 0;
  return fsv_drain_tap(bytes, capacity > INT32_MAX ? INT32_MAX : (int)capacity);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_slotStatus(JNIEnv *env, jclass cls, jint slot,
                                                                  jfloatArray out) {
  (void)cls;
  if (out == NULL) return;
  float values[FSV_STATUS_LEN];
  fsv_slot_status(slot, values);
  jsize length = (*env)->GetArrayLength(env, out);
  (*env)->SetFloatArrayRegion(env, out, 0, length < FSV_STATUS_LEN ? length : FSV_STATUS_LEN, values);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_engineStats(JNIEnv *env, jclass cls, jlongArray out) {
  (void)cls;
  if (out == NULL) return;
  int64_t values[FSV_STATS_LEN];
  fsv_engine_stats(values);
  jlong longs[FSV_STATS_LEN];
  for (int i = 0; i < FSV_STATS_LEN; i++) longs[i] = values[i];
  jsize length = (*env)->GetArrayLength(env, out);
  (*env)->SetLongArrayRegion(env, out, 0, length < FSV_STATS_LEN ? length : FSV_STATS_LEN, longs);
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_measureMonitor(JNIEnv *env, jclass cls, jint slot) {
  (void)env;
  (void)cls;
  return fsv_measure_monitor(slot);
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_monitorResult(JNIEnv *env, jclass cls, jint token,
                                                                     jfloatArray out) {
  (void)cls;
  if (out == NULL) return;
  float values[3];
  fsv_monitor_result(token, values);
  jsize length = (*env)->GetArrayLength(env, out);
  (*env)->SetFloatArrayRegion(env, out, 0, length < 3 ? length : 3, values);
}
