package dev.weiqi.sniffer.core

import kotlin.concurrent.Volatile

/** How a paused response continues. Resume applies any non-null edit; nulls keep the original. */
sealed interface BreakpointResolution {
    data class Resume(
        val status: Int? = null,
        val headers: Map<String, String>? = null,
        val body: String? = null,
    ) : BreakpointResolution

    object Abort : BreakpointResolution
}

/** Armed breakpoint rules. The daemon replaces the full set on every update. */
object BreakpointRegistry {
    @Volatile
    private var rules: List<BreakpointRule> = emptyList()

    val armed: Boolean get() = rules.any { it.enabled }

    fun update(newRules: List<BreakpointRule>) {
        rules = newRules
    }

    // Exact-path match (same semantics as MockRegistry): [urlPattern] must equal the request's
    // path, both normalized. A full-URL pattern still matches its path.
    fun match(method: String, url: String, phase: String): BreakpointRule? {
        val path = urlPath(url)
        return rules.firstOrNull {
            it.enabled && it.phase == phase &&
                (it.method == null || it.method.equals(method, ignoreCase = true)) &&
                path == urlPath(it.urlPattern)
        }
    }
}
