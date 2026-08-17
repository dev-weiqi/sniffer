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
            implementation(libs.ktor.client.mock)
        }
        jvmTest.dependencies {
            implementation(kotlin("test"))
            implementation(libs.ktor.client.mock)
            // a real engine: MockEngine saves the body eagerly, so error-path body capture
            // looks fine under it while a real engine drops it (see SnifferKtorRealEngineTest)
            implementation(libs.ktor.client.cio)
            implementation(libs.ktor.client.okhttp)
            implementation("io.ktor:ktor-client-auth:${libs.versions.ktor.get()}")
        }
    }
}
