package dev.weiqi.sniffer.core

/** Request path with scheme, host, query and fragment stripped ("/api/x?q=1" -> "/api/x"). */
internal fun urlPath(url: String): String {
    val path = if (url.contains("://")) "/" + url.substringAfter("://").substringAfter('/', "") else url
    return path.substringBefore('?').substringBefore('#')
}
