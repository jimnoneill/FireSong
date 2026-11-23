// Tuning values of the native voice chain. The first block mirrors
// client/src/audio/voice-params.ts (line cited per value); keep both in step.
#pragma once

/* client/src/audio/voice-params.ts */
#define FSV_HPF_HZ 100.0f                     /* :7 */
#define FSV_COMPRESSOR_THRESHOLD_DB -24.0f    /* :9 */
#define FSV_COMPRESSOR_RATIO 4.0f             /* :10 */
#define FSV_BUS_COMPRESSOR_THRESHOLD_DB -18.0f /* :11 */
#define FSV_BUS_COMPRESSOR_RATIO 3.0f         /* :12 */
#define FSV_LIMITER_THRESHOLD_DB -6.0f        /* :13 */
#define FSV_LIMITER_RATIO 20.0f               /* :14 */
#define FSV_ECHO_DELAY_MS 120                 /* :23 */
#define FSV_ECHO_MAX_DELAY_MS 220             /* :25 */
#define FSV_ECHO_FEEDBACK 0.48f               /* :26 */
#define FSV_ECHO_LOWPASS_HZ 3000.0f           /* :27 */
#define FSV_ECHO_HIGHPASS_HZ 300.0f           /* :29 */
#define FSV_ECHO_WET_GAIN 0.36f               /* :30 */
#define FSV_REVERB_SEND 0.14f                 /* :32 */
#define FSV_REVERB_SECONDS 1.4f               /* :33 */
#define FSV_GATE_THRESHOLD_DB -60.0f          /* :40 */
#define FSV_VOICE_TARGET_DB -24.0f            /* :50 */
#define FSV_VOICE_MAX_BOOST_DB 24.0f          /* :51 */
#define FSV_VOICE_START_BOOST_DB 12.0f        /* :53 */
#define FSV_VOICE_FLOOR_DB -54.0f             /* :54 */
#define FSV_VOICE_RISE_SEC 0.3f               /* :55 */
#define FSV_VOICE_FALL_SEC 20.0f              /* :56 */
#define FSV_VOICE_HOWL_CUT_DB 6.0f            /* :58 */
#define FSV_FEEDBACK_PROMINENCE_DB 15.0f      /* :60 */
#define FSV_FEEDBACK_HOLD_MS 300              /* :61 */
#define FSV_FEEDBACK_NOTCH_DB -12.0f          /* :62 */
#define FSV_FEEDBACK_NOTCH_Q 30.0f            /* :63 */
#define FSV_FEEDBACK_DUCK_DB -6.0f            /* :64 */
#define FSV_FEEDBACK_RELEASE_MS 4000          /* :65 */
#define FSV_MAX_WET_GAIN 0.6f                 /* :97 */

/* The rest of the page's graph (client/src/audio). */
#define FSV_RAMP_SEC 0.02f                    /* mic-rack.ts RAMP_SEC: fader, monitor, notch gain, sends, echo */
#define FSV_BOOST_RAMP_SEC 0.25f              /* mic-rack.ts setBoost */
#define FSV_SINGING_START_DB (FSV_VOICE_TARGET_DB - FSV_VOICE_START_BOOST_DB) /* mic-rack.ts `singing` */
#define FSV_GUARD_FFT_SIZE 2048               /* mic-rack.ts GUARD_FFT_SIZE */
#define FSV_GUARD_FRAMES 2400                 /* mic-rack.ts GUARD_INTERVAL_MS (50 ms) in frames */
#define FSV_COMPRESSOR_KNEE_DB 30.0f          /* DynamicsCompressorNode defaults */
#define FSV_COMPRESSOR_ATTACK_SEC 0.003f
#define FSV_COMPRESSOR_RELEASE_SEC 0.25f
#define FSV_LIMITER_KNEE_DB 0.0f              /* voice-engine.ts voice limiter */
#define FSV_LIMITER_ATTACK_SEC 0.001f         /* voice-engine.ts LIMITER_ATTACK_SEC */
#define FSV_LIMITER_RELEASE_SEC 0.1f          /* voice-engine.ts LIMITER_RELEASE_SEC */

/* Output headroom: voices stay at or under half of full scale (the song gets the other half). */
#define FSV_VOICE_TRIM_DB -4.0f
#define FSV_VOICE_CEILING 0.5f

/* Monitor beep: the scoring beep's tone (client/src/features/microphone/lib/latency-test.ts:8-13), as a sine. */
#define FSV_BEEP_BASELINE_MS 300
#define FSV_BEEP_TIMEOUT_MS 2200
#define FSV_BEEP_LEAD_MS 120
#define FSV_BEEP_HZ 1000.0f
#define FSV_BEEP_MS 160
#define FSV_BEEP_GAIN 0.9f
#define FSV_BEEP_ATTACK_MS 10
#define FSV_BEEP_RELEASE_MS 20
#define FSV_BEEP_WINDOW 256
#define FSV_BEEP_HOP 128

/* Reverb: an 8-line feedback delay network standing in for the convolver. */
#define FSV_FDN_LINES 8
#define FSV_FDN_LENGTHS {1123, 1361, 1597, 1847, 2087, 2333, 2593, 2851}
