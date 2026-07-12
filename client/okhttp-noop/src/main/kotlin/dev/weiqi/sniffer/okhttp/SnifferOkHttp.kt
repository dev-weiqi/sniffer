package dev.weiqi.sniffer.okhttp

import okhttp3.Interceptor

/** Release-build stand-in: pass-through interceptor. */
object SnifferOkHttp {
    fun interceptor(ignoredHosts: Set<String> = emptySet()): Interceptor = Interceptor { chain -> chain.proceed(chain.request()) }
}
