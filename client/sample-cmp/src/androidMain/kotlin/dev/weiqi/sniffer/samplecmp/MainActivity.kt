package dev.weiqi.sniffer.samplecmp

import android.app.Application
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import dev.weiqi.sniffer.core.Sniffer
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class SampleCmpApp : Application() {
    override fun onCreate() {
        super.onCreate()
        Sniffer.start(appId = packageName)
    }
}

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent { App() }
    }
}

internal actual fun timeNow(): String =
    SimpleDateFormat("HH:mm:ss", Locale.US).format(Date())
