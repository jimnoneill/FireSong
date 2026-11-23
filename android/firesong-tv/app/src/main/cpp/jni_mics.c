// JNI for org.firesong.tv.NativeMics: one entry per external function.
#include <jni.h>

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_abi(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  return 0;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_start(JNIEnv *env, jclass cls) {
  (void)env;
  (void)cls;
  return 0;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_stop(JNIEnv *env, jclass cls, jint token) {
  (void)env;
  (void)cls;
  (void)token;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_attach(JNIEnv *env, jclass cls, jint slot, jint gen) {
  (void)env;
  (void)cls;
  (void)slot;
  (void)gen;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_detach(JNIEnv *env, jclass cls, jint slot, jint gen) {
  (void)env;
  (void)cls;
  (void)slot;
  (void)gen;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_release(JNIEnv *env, jclass cls, jint slot) {
  (void)env;
  (void)cls;
  (void)slot;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_push(JNIEnv *env, jclass cls, jint slot, jint gen, jobject pcm,
                                                            jint frames, jint rate, jint channels) {
  (void)env;
  (void)cls;
  (void)slot;
  (void)gen;
  (void)pcm;
  (void)frames;
  (void)rate;
  (void)channels;
  return -1;
}

JNIEXPORT jboolean JNICALL Java_org_firesong_tv_NativeMics_set(JNIEnv *env, jclass cls, jint slot, jint control,
                                                               jfloat value) {
  (void)env;
  (void)cls;
  (void)slot;
  (void)control;
  (void)value;
  return JNI_FALSE;
}

JNIEXPORT jboolean JNICALL Java_org_firesong_tv_NativeMics_setEchoMix(JNIEnv *env, jclass cls, jfloat wet,
                                                                      jfloat feedback, jfloat lowpass_hz,
                                                                      jfloat reverb_send) {
  (void)env;
  (void)cls;
  (void)wet;
  (void)feedback;
  (void)lowpass_hz;
  (void)reverb_send;
  return JNI_FALSE;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_drainTap(JNIEnv *env, jclass cls, jobject out) {
  (void)env;
  (void)cls;
  (void)out;
  return 0;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_slotStatus(JNIEnv *env, jclass cls, jint slot,
                                                                  jfloatArray out) {
  (void)env;
  (void)cls;
  (void)slot;
  (void)out;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_engineStats(JNIEnv *env, jclass cls, jlongArray out) {
  (void)env;
  (void)cls;
  (void)out;
}

JNIEXPORT jint JNICALL Java_org_firesong_tv_NativeMics_measureMonitor(JNIEnv *env, jclass cls, jint slot) {
  (void)env;
  (void)cls;
  (void)slot;
  return 0;
}

JNIEXPORT void JNICALL Java_org_firesong_tv_NativeMics_monitorResult(JNIEnv *env, jclass cls, jint token,
                                                                     jfloatArray out) {
  (void)env;
  (void)cls;
  (void)token;
  (void)out;
}
