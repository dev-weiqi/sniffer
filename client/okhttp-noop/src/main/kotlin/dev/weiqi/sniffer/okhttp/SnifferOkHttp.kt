package dev.weiqi.sniffer.okhttp

import okhttp3.Interceptor

/** Release-build stand-in: pass-through interceptor. */
object SnifferOkHttp {
    fun interceptor(): Interceptor = Interceptor { chain -> chain.proceed(chain.request()) }
}
