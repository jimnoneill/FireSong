// The slot's automatic level (mic-rack.ts levelVoice) and its howl ceiling.
#include <math.h>

#include "dsp.h"
#include "params.h"

void fsv_level_init(fsv_level *l) {
  l->singing = pow(10.0, FSV_SINGING_START_DB / 20.0);
  l->boost_db = FSV_VOICE_START_BOOST_DB;
  l->ceiling_db = FSV_VOICE_MAX_BOOST_DB;
}

/* One step on the latest gate meter block: follows the loud parts of the singing (quickly up,
   slowly down) and aims the boost at FSV_VOICE_TARGET_DB, under the ceiling. */
int fsv_level_step(fsv_level *l, float level_rms, int gate_open, float elapsed_s) {
  if (!gate_open || !(level_rms > 0.0f) || 20.0 * log10((double)level_rms) < FSV_VOICE_FLOOR_DB) return 0;
  const double rms = level_rms;
  const double seconds = rms > l->singing ? FSV_VOICE_RISE_SEC : FSV_VOICE_FALL_SEC;
  l->singing += (rms - l->singing) * -expm1(-(double)elapsed_s / seconds);
  const double wanted = fmin(l->ceiling_db, fmax(0.0, FSV_VOICE_TARGET_DB - 20.0 * log10(l->singing)));
  if (fabs(wanted - l->boost_db) < 0.5) return 0;
  l->boost_db = (float)wanted;
  return 1;
}

void fsv_level_howl(fsv_level *l) {
  l->ceiling_db = fmaxf(0.0f, l->ceiling_db - FSV_VOICE_HOWL_CUT_DB);
  l->boost_db = fminf(l->boost_db, l->ceiling_db);
}
