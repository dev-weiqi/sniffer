package dev.weiqi.sniffer.core

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotEquals
import kotlin.test.assertTrue

class MockPlaceholdersTest {
    @Test
    fun expands_unique_id_each_time() {
        val first = expandMockPlaceholders("""{"id":"${'$'}{id}"}""")
        val second = expandMockPlaceholders("""{"id":"${'$'}{id}"}""")

        assertNotEquals(first, second)
        assertTrue(first.contains(""""id":""""))
        assertTrue(second.contains(""""id":""""))
    }

    @Test
    fun expands_lorem_string_to_requested_length() {
        val expanded = expandMockPlaceholders("""{"name":"${'$'}{randomString(10)}"}""")
        val value = expanded.substringAfter(""""name":"""").trim('"', '}')

        assertEquals(10, value.length)
        assertTrue(value.all { it in 'a'..'z' })
    }

    @Test
    fun random_string_length_is_capped() {
        // a huge requested length must not OOM the host
        val expanded = expandMockPlaceholders("${'$'}{randomString(2000000000)}")

        assertEquals(MAX_BODY_CHARS, expanded.length)
    }

    @Test
    fun leaves_unknown_placeholders_unchanged() {
        assertEquals(
            """{"x":"${'$'}{unknown}"}""",
            expandMockPlaceholders("""{"x":"${'$'}{unknown}"}"""),
        )
    }
}
