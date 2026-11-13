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
            devtools = if (p.contains("devtools")) p.getBoolean("devtools", false) else null,
        )
    }

    // commit(), not apply(): the values must be on disk before a possible
    // process kill right after a .Configure intent.
    @SuppressLint("ApplySharedPref")
    fun save(ctx: Context, s: TvSettings) {
        val e = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE).edit().clear()
        s.url?.let { e.putString("url", it) }
        s.hostToken?.let { e.putString("host_token", it) }
        s.boundOrigin?.let { e.putString("bound_origin", it) }
        if (s.leafPins.isNotEmpty()) e.putString("leaf_pins", s.leafPins.joinToString(","))
        s.devtools?.let { e.putBoolean("devtools", it) }
        e.commit()
    }
}
