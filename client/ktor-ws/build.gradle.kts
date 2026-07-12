plugins {
    alias(libs.plugins.kotlin.multiplatform)
}

kotlin {
    jvm()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        commonMain.dependencies {
            api(project(":core"))
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.websockets)
        }
        jvmTest.dependencies {
            implementation(project(":ktor"))
            implementation(libs.ktor.client.cio)
            implementation(kotlin("test"))
        }
    }
}

tasks.register<JavaExec>("wsDebug") {
    classpath = kotlin.jvm().compilations["test"].runtimeDependencyFiles +
        kotlin.jvm().compilations["test"].output.allOutputs
    mainClass = "dev.weiqi.sniffer.ktorws.WsEchoDebugKt"
}

// WsEchoDebug is a debug harness that needs a live daemon (./gradlew :ktor-ws:wsDebug), not a unit test
tasks.withType<Test>().configureEach { failOnNoDiscoveredTests = false }

tasks.register<JavaExec>("sseDebug") {
    classpath = kotlin.jvm().compilations["test"].runtimeDependencyFiles +
        kotlin.jvm().compilations["test"].output.allOutputs
    mainClass = "dev.weiqi.sniffer.ktorws.SseDebugKt"
}
