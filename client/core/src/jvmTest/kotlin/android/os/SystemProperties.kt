package android.os

class SystemProperties {
    companion object {
        private val values = mutableMapOf<String, String>()

        @JvmStatic
        fun get(key: String): String = values[key].orEmpty()

        @JvmStatic
        fun set(key: String, value: String?) {
            if (value == null) values.remove(key) else values[key] = value
        }

        @JvmStatic
        fun clear() {
            values.clear()
        }
    }
}
