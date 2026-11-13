package org.firesong.tv

import android.annotation.SuppressLint
import android.content.Context

/** SharedPreferences storage for [TvSettings]. `allowBackup=false` keeps the token off backups. */
object Prefs {
    private const val NAME = "firesong"

    fun load(ctx: Context): TvSettings {
        val p = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)
        return TvSettings(
            url = p.getString("url", null),
            hostToken = p.getString("host_token", null),
            boundOrigin = p.getString("bound_origin", null),
            leafPins = p.getString("leaf_pins", "").orEmpty().split(',').filter { it.isNotBlank() },
            uiDensity = p.getInt("ui_density", 0),
            devtools = if (p.contains("devtools")) p.getBoolean("devtools", false) else null,
        )
    }

    // commit(), not apply(): a density change recreates the activity, which
    // must read the new value in attachBaseContext.
    @SuppressLint("ApplySharedPref")
    fun save(ctx: Context, s: TvSettings) {
        val e = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit().clear()
        s.url?.let { e.putString("url", it) }
        s.hostToken?.let { e.putString("host_token", it) }
        s.boundOrigin?.let { e.putString("bound_origin", it) }
        if (s.leafPins.isNotEmpty()) e.putString("leaf_pins", s.leafPins.joinToString(","))
        if (s.uiDensity != 0) e.putInt("ui_density", s.uiDensity)
        s.devtools?.let { e.putBoolean("devtools", it) }
        e.commit()
    }
}
