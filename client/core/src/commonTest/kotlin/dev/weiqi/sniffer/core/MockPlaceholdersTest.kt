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
    fun expands_random_number_in_inclusive_range() {
        repeat(20) {
            val expanded = expandMockPlaceholders("""{"n":${'$'}{randomNumber(3~5)}}""")
            val value = expanded.substringAfter(""""n":""").substringBefore("}").toLong()

            assertTrue(value in 3..5)
        }
    }

    @Test
    fun leaves_unknown_placeholders_unchanged() {
        assertEquals(
            """{"x":"${'$'}{unknown}"}""",
            expandMockPlaceholders("""{"x":"${'$'}{unknown}"}"""),
        )
    }
}
