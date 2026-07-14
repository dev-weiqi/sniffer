package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class MockPlaceholdersTest {
    @Test
    fun expands_unique_random_id_each_time() {
        val first = expandMockPlaceholders("""{"id":"${'$'}{randomId}"}""")
        val second = expandMockPlaceholders("""{"id":"${'$'}{randomId}"}""")

        assertNotEquals(first, second)
        assertTrue(first.contains(""""id":""""))
        assertTrue(second.contains(""""id":""""))
    }

    @Test
    fun expands_lorem_string_length_within_range() {
        val value = expandMockPlaceholders("""{"name":"${'$'}{randomString(5~8)}"}""")
            .substringAfter(""""name":"""").trim('"', '}')

        assertTrue(value.length in 5..8, "got length ${value.length}")
        assertTrue(value.all { it in 'a'..'z' })
    }

    @Test
    fun exact_range_is_deterministic_length() {
        val value = expandMockPlaceholders("${'$'}{randomString(10~10)}")
        assertEquals(10, value.length)
    }

    @Test
    fun random_string_length_is_capped() {
        // a huge requested range must not OOM the host
        val expanded = expandMockPlaceholders("${'$'}{randomString(2000000000~2000000000)}")

        assertEquals(MAX_BODY_CHARS, expanded.length)
    }

    @Test
    fun expands_now_to_iso_utc() {
        val expanded = expandMockPlaceholders("""{"at":"${'$'}{now}"}""")
        val value = expanded.substringAfter(""""at":"""").trim('"', '}')

        assertNotEquals("""${'$'}{now}""", value)
        // ISO-8601 UTC: yyyy-MM-ddTHH:mm:ss...Z
        assertTrue(value.matches(Regex("""\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.*Z""")), "got: $value")
    }

    @Test
    fun leaves_unknown_placeholders_unchanged() {
        assertEquals(
            """{"x":"${'$'}{unknown}"}""",
            expandMockPlaceholders("""{"x":"${'$'}{unknown}"}"""),
        )
    }
}
