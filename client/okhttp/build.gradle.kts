plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    api(project(":core"))
    compileOnly(libs.okhttp)
    testImplementation(libs.okhttp)
    testImplementation(kotlin("test"))
}
