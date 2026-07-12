package dev.weiqi.sniffer.core

/** Release-build stand-in: same app-facing API as core, all no-ops. */
object Sniffer {
    fun start(
        appId: String,
        host: String = "localhost",
        port: Int = 9091,
        deviceName: String? = null,
    ) = Unit

    fun stop() = Unit
}
