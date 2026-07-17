package dev.weiqi.sniffer.core

import kotlinx.coroutines.CompletableDeferred
import kotlin.concurrent.Volatile

/**
 * Registry of paused responses. The whole risk of breakpoints is golden rule 3 — the host thread
 * must always be released — so every exit routes through here:
 *  - resume/abort: the daemon's resolve completes the waiter ([resolve])
 *  - daemon disconnect mid-pause: [releaseAll] completes every waiter with Resume()
 *  - not connected: [open] refuses to pause, so a response never blocks when no one can resolve it
 *  - host-cancel (call timeout): the awaiter's coroutine cancels; [await]'s finally [close]s it
 */
object Breakpoints {
    @Volatile
    var connected: Boolean = false

    // copy-on-write immutable map, same idiom as Sniffer.pushHandlers (keeps resolve non-suspend so
    // the daemon message handler stays testable without a coroutine runner)
    // ponytail: two responses pausing in the same instant could lose a waiter to the read-modify-write
    // race; the disconnect safety net still frees it. Switch to atomicfu if that ever bites.
    @Volatile
    private var pending: Map<String, CompletableDeferred<BreakpointResolution>> = emptyMap()

    /** Registers a waiter for [id], or null if we can't be resolved (disconnected). */
    internal fun open(id: String): CompletableDeferred<BreakpointResolution>? {
        val deferred = CompletableDeferred<BreakpointResolution>()
        // register first, then check: if we're disconnected (or a disconnect + releaseAll raced us),
        // drop the waiter and refuse to pause — nothing would ever resolve it.
        pending = pending + (id to deferred)
        if (!connected) {
            pending = pending - id
            return null
        }
        return deferred
    }

    internal fun close(id: String) {
        pending = pending - id
    }

    internal fun resolve(id: String, resolution: BreakpointResolution) {
        pending[id]?.let {
            pending = pending - id
            it.complete(resolution)
        }
    }

    /** Completes every paused response with [resolution]. */
    fun resolveAll(resolution: BreakpointResolution) {
        val waiters = pending.values.toList()
        pending = emptyMap()
        waiters.forEach { it.complete(resolution) }
    }

    /** Releases every paused response with Resume() — the disconnect safety net. */
    internal fun releaseAll() = resolveAll(BreakpointResolution.Resume())

    val pendingCount: Int get() = pending.size

    /**
     * Sends the hit and suspends until resolved. Returns Resume() immediately when disconnected, and
     * the finally drops the waiter on host-cancel — so the host call is always released.
     */
    internal suspend fun await(id: String, sendHit: () -> Unit): BreakpointResolution {
        val deferred = open(id) ?: return BreakpointResolution.Resume()
        sendHit()
        return try {
            deferred.await()
        } finally {
            close(id)
        }
    }
}
