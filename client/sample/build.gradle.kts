plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.compose.multiplatform)
}

android {
    namespace = "dev.weiqi.sniffer.sample"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.weiqi.sniffer.sample"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    // ponytail: the sample wires everything; real apps use debugImplementation and pick modules
    implementation(project(":core"))
    implementation(project(":okhttp"))
    implementation(project(":ktor"))
    implementation(project(":ktor-ws"))
    implementation(project(":socketio"))

    implementation(libs.okhttp)
    implementation(libs.socketio.client)
    implementation(libs.ktor.client.core)
    implementation(libs.ktor.client.cio)
    implementation(libs.ktor.client.websockets)
    implementation(libs.kotlinx.coroutines.core)

    implementation(libs.androidx.activity.compose)
    implementation(compose.runtime)
    implementation(compose.foundation)
    implementation(compose.material3)
    implementation(compose.ui)
}
