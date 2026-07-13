package dev.weiqi.sniffer.ktorws

import io.ktor.client.plugins.api.ClientPlugin
import io.ktor.client.plugins.api.createClientPlugin

/** Release-build stand-in: installs nothing, sessions stay raw. */
val SnifferKtorWs: ClientPlugin<Unit> = createClientPlugin("SnifferKtorWs") {}
