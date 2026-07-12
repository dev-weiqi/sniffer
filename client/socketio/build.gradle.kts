plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    api(project(":core"))
    compileOnly(libs.socketio.client)
    testImplementation(libs.socketio.client)
    testImplementation(kotlin("test"))
}
