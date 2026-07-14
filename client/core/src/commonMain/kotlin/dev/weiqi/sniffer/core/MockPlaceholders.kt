package dev.weiqi.sniffer.core

import kotlin.random.Random

// The closing brace MUST be escaped: Android's ICU regex engine rejects a bare `}`
// (PatternSyntaxException at class-init -> ExceptionInInitializerError in the host app),
// while the JVM engine silently accepts it -- jvmTest alone cannot catch this.
private val PlaceholderPattern = Regex("""\$\{([^}]+)\}""")
private val RandomStringPattern = Regex("""randomString\(\s*(\d+)\s*~\s*(\d+)\s*\)""")
private const val LoremLetters = "loremipsumdolorsitametconsecteturadipiscingelit"

fun expandMockPlaceholders(template: String): String =
    PlaceholderPattern.replace(template) { match ->
        val token = match.groupValues[1]
        when {
            token == "randomId" -> newId()
            token == "now" -> nowIso()
            RandomStringPattern.matches(token) -> {
                val m = RandomStringPattern.matchEntire(token) ?: return@replace match.value
                val min = m.groupValues[1].toIntOrNull() ?: return@replace match.value
                val max = m.groupValues[2].toIntOrNull() ?: return@replace match.value
                if (min > max) return@replace match.value
                randomLoremString(randomLengthInRange(min, max))
            }
            else -> match.value
        }
    }

// random length within [min, max]; both clamped first so a huge range neither overflows nor OOMs
private fun randomLengthInRange(min: Int, max: Int): Int {
    val lo = min.coerceIn(0, MAX_BODY_CHARS)
    val hi = max.coerceIn(0, MAX_BODY_CHARS)
    return lo + Random.nextInt(hi - lo + 1)
}

private fun randomLoremString(length: Int): String {
    if (length <= 0) return ""
    val capped = length.coerceAtMost(MAX_BODY_CHARS)
    return buildString(capped) {
        repeat(capped) {
            append(LoremLetters[Random.nextInt(LoremLetters.length)])
        }
    }
}

