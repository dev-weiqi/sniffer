package dev.weiqi.sniffer.ktor

import io.ktor.client.plugins.api.createClientPlugin

/** Release-build stand-in: a plugin that does nothing. */
val SnifferKtor = createClientPlugin("SnifferKtor") {}
