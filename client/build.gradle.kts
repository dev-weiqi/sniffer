import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.tasks.KotlinCompile

plugins {
    alias(libs.plugins.kotlin.multiplatform) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.compose.multiplatform) apply false
    alias(libs.plugins.maven.publish) apply false
}

// Coordinates come from gradle.properties (GROUP / VERSION_NAME) so a release bumps one place.
allprojects {
    group = property("GROUP") as String
    version = property("VERSION_NAME") as String
}

// Publish the library modules to Maven (e.g. mavenLocal) so consumer apps depend on the built
// artifacts instead of composite-building the source — that decouples them from this build's AGP
// version. The Android sample modules are never published.
subprojects {
    if (name == "sample" || name == "sample-cmp") return@subprojects

    // published library jars must target JVM 17 bytecode so consumers on JDK 17 can read them
    tasks.withType(KotlinCompile::class.java).configureEach {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }

    // JVM-only modules (okhttp, socketio + their -noop twins)
    plugins.withId("org.jetbrains.kotlin.jvm") {
        apply(plugin = "com.vanniktech.maven.publish")
        extensions.configure(org.gradle.api.plugins.JavaPluginExtension::class.java) {
            sourceCompatibility = JavaVersion.VERSION_17
            targetCompatibility = JavaVersion.VERSION_17
        }
    }

    // KMP modules (core, ktor, ktor-ws + their -noop twins). The vanniktech plugin registers
    // publications (with sources/javadoc jars), signing, and the Central portal upload for both
    // module shapes; coordinates and POM come from gradle.properties (GROUP / VERSION_NAME / POM_*).
    plugins.withId("org.jetbrains.kotlin.multiplatform") {
        apply(plugin = "com.vanniktech.maven.publish")
    }
}
