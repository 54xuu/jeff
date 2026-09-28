package app.jeff.mobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/** 按电脑分桶缓存会话列表和消息。电脑离线时只读这些。 */
class CacheDb(ctx: Context) : SQLiteOpenHelper(ctx, "jeff-cache.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE entry (desktop_id TEXT NOT NULL, key TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (desktop_id, key))",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

    fun get(desktopId: String, key: String): String {
        val c = readableDatabase.query("entry", arrayOf("json"), "desktop_id=? AND key=?", arrayOf(desktopId, key), null, null, null)
        c.use { return if (it.moveToFirst()) it.getString(0) else "" }
    }

    fun put(desktopId: String, key: String, json: String) {
        val v = ContentValues()
        v.put("desktop_id", desktopId)
        v.put("key", key)
        v.put("json", json)
        v.put("updated_at", System.currentTimeMillis())
        writableDatabase.insertWithOnConflict("entry", null, v, SQLiteDatabase.CONFLICT_REPLACE)
    }
}
