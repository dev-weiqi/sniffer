plugins {
    alias(libs.plugins.kotlin.multiplatform)
    alias(libs.plugins.kotlin.serialization)
}

kotlin {
    jvm()
    iosArm64()
    iosSimulatorArm64()

    sourceSets {
        all {
            languageSettings.optIn("kotlin.uuid.ExperimentalUuidApi")
        }
        commonMain.dependencies {
            api(libs.kotlinx.coroutines.core)
            api(libs.kotlinx.serialization.json)
            implementation(libs.ktor.client.core)
            implementation(libs.ktor.client.cio)
            implementation(libs.ktor.client.websockets)
            // USB transport: the SDK is the WebSocket *server* side there (see UsbServer.kt)
            implementation(libs.ktor.network)
            implementation(libs.ktor.websockets)
            implementation(libs.ktor.http.cio)
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
        }
    }
}
