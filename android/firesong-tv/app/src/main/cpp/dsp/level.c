// The slot's automatic level (mic-rack.ts levelVoice) and its howl ceiling.
#include "dsp.h"
#include "params.h"

void fsv_level_init(fsv_level *l) {
  l->singing = 0.0;
  l->boost_db = FSV_VOICE_START_BOOST_DB;
  l->ceiling_db = FSV_VOICE_MAX_BOOST_DB;
}

int fsv_level_step(fsv_level *l, float level_rms, int gate_open, float elapsed_s) {
  (void)l;
  (void)level_rms;
  (void)gate_open;
  (void)elapsed_s;
  return 0;
}

void fsv_level_howl(fsv_level *l) { (void)l; }
