plugins {
    alias(libs.plugins.kotlin.multiplatform)
}

kotlin {
    jvm()
    iosArm64()
    iosSimulatorArm64()
    sourceSets.commonTest.dependencies { implementation(kotlin("test")) }
}
