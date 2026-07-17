package dev.weiqi.sniffer.core

import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The four ways a paused response must always release (golden rule 3). */
class BreakpointsTest {

    @AfterTest
    fun reset() {
        Breakpoints.connected = false
        Breakpoints.releaseAll()
        Sniffer.reportSinkForTests = null
    }

    @Test
    fun doesNotPauseWhenDisconnected() {
        Breakpoints.connected = false
        assertNull(Breakpoints.open("h1"))
        assertEquals(0, Breakpoints.pendingCount)
    }

    @Test
    fun resolveCompletesTheWaiter() = runBlocking {
        Breakpoints.connected = true
        val deferred = Breakpoints.open("h1")!!
        assertEquals(1, Breakpoints.pendingCount)
        val waiter = async { deferred.await() }
        Breakpoints.resolve("h1", BreakpointResolution.Resume(status = 201))
        assertEquals(BreakpointResolution.Resume(status = 201), withTimeout(1000) { waiter.await() })
        assertEquals(0, Breakpoints.pendingCount)
    }

    @Test
    fun resolveOfUnknownIdIsNoOp() {
        Breakpoints.connected = true
        Breakpoints.resolve("missing", BreakpointResolution.Abort)
        assertEquals(0, Breakpoints.pendingCount)
    }

    @Test
    fun disconnectReleasesEveryWaiterWithResume() = runBlocking {
        Breakpoints.connected = true
        val a = Breakpoints.open("h1")!!
        val b = Breakpoints.open("h2")!!
        assertEquals(2, Breakpoints.pendingCount)
        Breakpoints.connected = false
        Breakpoints.releaseAll()
        assertEquals(BreakpointResolution.Resume(), withTimeout(1000) { a.await() })
        assertEquals(BreakpointResolution.Resume(), withTimeout(1000) { b.await() })
        assertEquals(0, Breakpoints.pendingCount)
    }

    @Test
    fun closeRemovesWaiter() {
        Breakpoints.connected = true
        Breakpoints.open("h1")
        assertEquals(1, Breakpoints.pendingCount)
        Breakpoints.close("h1")
        assertEquals(0, Breakpoints.pendingCount)
    }

    @Test
    fun awaitReturnsResumeImmediatelyWhenDisconnected() = runBlocking {
        Breakpoints.connected = false
        var sent = false
        val res = Breakpoints.await("h1") { sent = true }
        assertEquals(BreakpointResolution.Resume(), res)
        assertEquals(false, sent) // never announced a pause that can't be resolved
    }

    @Test
    fun awaitSendsHitThenResolves() = runBlocking {
        Breakpoints.connected = true
        var sent = false
        val waiter = async { Breakpoints.await("h1") { sent = true } }
        while (Breakpoints.pendingCount == 0) yield()
        assertEquals(true, sent)
        Breakpoints.resolve("h1", BreakpointResolution.Abort)
        assertEquals(BreakpointResolution.Abort, withTimeout(1000) { waiter.await() })
        assertEquals(0, Breakpoints.pendingCount) // await's finally dropped the waiter
    }

    @Test
    fun snifferAwaitBreakpointDelegatesAndReportsHit() = runBlocking {
        val reported = mutableListOf<DeviceMessage>()
        Sniffer.reportSinkForTests = reported::add
        Breakpoints.connected = true
        val hit = BreakpointHitMsg(
            id = "h1", ruleId = "b1", phase = "response", method = "GET", url = "http://h/x",
            status = 200, headers = emptyMap(), body = "{}", library = "okhttp", timestamp = 1,
        )
        val waiter = async { Sniffer.awaitBreakpoint(hit) }
        while (Breakpoints.pendingCount == 0) yield()
        Breakpoints.resolve("h1", BreakpointResolution.Resume(body = "edited"))
        assertEquals(BreakpointResolution.Resume(body = "edited"), withTimeout(1000) { waiter.await() })
        assertEquals(listOf<DeviceMessage>(hit), reported)
    }
}
