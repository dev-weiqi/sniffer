rootProject.name = "sniffer-client"

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        google()
        mavenCentral()
    }
}

include(":core", ":okhttp", ":ktor", ":ktor-ws", ":socketio", ":sample", ":sample-cmp")
include(":core-noop", ":okhttp-noop", ":ktor-noop", ":ktor-ws-noop", ":socketio-noop")
