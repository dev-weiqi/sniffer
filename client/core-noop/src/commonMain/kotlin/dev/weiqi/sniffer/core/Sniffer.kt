package dev.weiqi.sniffer.core

/** Mirrors core's default so the no-op twin keeps identical call-site defaults. */
const val DEFAULT_PORT = 9091

/** Release-build stand-in: same app-facing API as core, all no-ops. */
object Sniffer {
    fun start(
        appId: String,
        host: String = "localhost",
        port: Int = DEFAULT_PORT,
        deviceName: String? = null,
    ) = Unit

    fun stop() = Unit
}
