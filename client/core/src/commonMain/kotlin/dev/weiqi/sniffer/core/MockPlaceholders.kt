package dev.weiqi.sniffer.core

import kotlin.random.Random

private val PlaceholderPattern = Regex("""\$\{([^}]+)}""")
private val RandomStringPattern = Regex("""randomString\(\s*(\d+)\s*\)""")
private val RandomNumberPattern = Regex("""randomNumber\(\s*(-?\d+)\s*~\s*(-?\d+)\s*\)""")
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
            RandomNumberPattern.matches(token) -> {
                val values = RandomNumberPattern.matchEntire(token)?.groupValues
                    ?: return@replace match.value
                val from = values[1].toLongOrNull() ?: return@replace match.value
                val to = values[2].toLongOrNull() ?: return@replace match.value
                randomNumber(from, to).toString()
            }
            else -> match.value
        }
    }

private fun randomLoremString(length: Int): String {
    if (length <= 0) return ""
    return buildString(length) {
        repeat(length) {
            append(LoremLetters[Random.nextInt(LoremLetters.length)])
        }
    }
}

private fun randomNumber(from: Long, to: Long): Long {
    val min = minOf(from, to)
    val max = maxOf(from, to)
    if (min == max) return min
    return Random.nextLong(from = min, until = max + 1)
}
