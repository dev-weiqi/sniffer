import kotlinx.kover.gradle.plugin.dsl.AggregationType
import kotlinx.kover.gradle.plugin.dsl.CoverageUnit
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinVersion
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
    alias(libs.plugins.kover)
}

dependencies {
    kover(project(":core"))
    kover(project(":okhttp"))
    kover(project(":ktor"))
    kover(project(":ktor-ws"))
    kover(project(":socketio"))
    kover(project(":core-noop"))
    kover(project(":okhttp-noop"))
    kover(project(":ktor-noop"))
    kover(project(":ktor-ws-noop"))
    kover(project(":socketio-noop"))
}

kover {
    reports {
        filters {
            excludes {
                annotatedBy("dev.weiqi.sniffer.core.CoverageExcluded")
                classes(
                    "dev.weiqi.sniffer.ktor.SnifferKtorKt\$SnifferKtor\$1\$2",
                    "dev.weiqi.sniffer.ktorws.SnifferKtorWsKt",
                    "dev.weiqi.sniffer.ktorws.SnifferKtorWsKt\$SnifferKtorWs\$1\$1",
                )
            }
        }
        verify {
            rule("line coverage is 100 percent") {
                minBound(100, CoverageUnit.LINE, AggregationType.COVERED_PERCENTAGE)
            }
        }
    }
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

    apply(plugin = "org.jetbrains.kotlinx.kover")

    // published library jars must target JVM 17 bytecode so consumers on JDK 17 can read them,
    // and Kotlin 2.2 metadata so consumers on older compilers (which read at most n+1) can too
    tasks.withType(KotlinCompile::class.java).configureEach {
        compilerOptions.jvmTarget.set(JvmTarget.JVM_17)
    }
    tasks.withType(org.jetbrains.kotlin.gradle.tasks.KotlinCompilationTask::class.java).configureEach {
        compilerOptions {
            languageVersion.set(KotlinVersion.KOTLIN_2_2)
            apiVersion.set(KotlinVersion.KOTLIN_2_2)
        }
    }
    // ...and must not drag a newer kotlin-stdlib onto the consumer's compile classpath
    plugins.withType(org.jetbrains.kotlin.gradle.plugin.KotlinBasePlugin::class.java) {
        extensions.configure(org.jetbrains.kotlin.gradle.dsl.KotlinProjectExtension::class.java) {
            coreLibrariesVersion = "2.2.0"
        }
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
