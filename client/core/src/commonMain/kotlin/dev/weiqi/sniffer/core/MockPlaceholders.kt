package dev.weiqi.sniffer.core

import kotlin.random.Random

// The closing brace MUST be escaped: Android's ICU regex engine rejects a bare `}`
// (PatternSyntaxException at class-init -> ExceptionInInitializerError in the host app),
// while the JVM engine silently accepts it -- jvmTest alone cannot catch this.
private val PlaceholderPattern = Regex("""\$\{([^}]+)\}""")
private val RandomStringPattern = Regex("""randomString\(\s*(\d+)\s*\)""")
private const val LoremLetters = "loremipsumdolorsitametconsecteturadipiscingelit"

fun expandMockPlaceholders(template: String): String =
    PlaceholderPattern.replace(template) { match ->
        val token = match.groupValues[1]
        when {
            token == "id" -> newId()
            RandomStringPattern.matches(token) -> {
                val length = RandomStringPattern.matchEntire(token)
                    ?.groupValues
                    ?.get(1)
                    ?.toIntOrNull()
                    ?: return@replace match.value
                randomLoremString(length)
            }
            else -> match.value
        }
    }

private fun randomLoremString(length: Int): String {
    if (length <= 0) return ""
    // cap: a rule asking for ${randomString(2000000000)} must not OOM the host app
    val capped = length.coerceAtMost(MAX_BODY_CHARS)
    return buildString(capped) {
        repeat(capped) {
            append(LoremLetters[Random.nextInt(LoremLetters.length)])
        }
    }
}

