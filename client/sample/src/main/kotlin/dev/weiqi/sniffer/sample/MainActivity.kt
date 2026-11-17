package dev.weiqi.sniffer.sample

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.weiqi.sniffer.core.DEFAULT_PORT

class MainActivity : ComponentActivity() {
    private val demo by lazy { DemoController() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme(
                primary = Color(0xFFB6A0E7), background = Color(0xFF1D1D26),
                surface = Color(0xFF24242E), onSurface = Color(0xFFEDEBF4),
                onSurfaceVariant = Color(0xFFB9B5C4), secondaryContainer = Color(0xFF30283F),
                onSecondaryContainer = Color(0xFFEDEBF4), outlineVariant = Color(0xFF383642),
            ) else lightColorScheme(
                primary = Color(0xFF60429C), background = Color(0xFFFAFAFD),
                surface = Color.White, onSurface = Color(0xFF262330),
                onSurfaceVariant = Color(0xFF686370), secondaryContainer = Color(0xFFF1EDF8),
                onSecondaryContainer = Color(0xFF60429C), outlineVariant = Color(0xFFE5E2EB),
            )) { SampleScreen(demo) }
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        demo.dispose()
    }
}

@Composable
private fun SampleScreen(demo: DemoController) {
    val listState = rememberLazyListState()
    LaunchedEffect(demo.entries.size) {
        if (demo.entries.isNotEmpty()) listState.animateScrollToItem(demo.entries.lastIndex)
    }
    val colors = MaterialTheme.colorScheme
    BoxWithConstraints(Modifier.fillMaxSize()) {
        val dockHeight = minOf(178.dp, maxHeight * 0.3f)
        Scaffold(
            topBar = {
                Column(Modifier.background(colors.background).statusBarsPadding()) {
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 16.dp),
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Box(Modifier.size(30.dp).border(2.dp, colors.primary, RoundedCornerShape(8.dp)),
                            contentAlignment = Alignment.Center) {
                            Text("⌁", color = colors.primary, fontSize = 20.sp)
                        }
                        Column(Modifier.weight(1f)) {
                            Text("Sniffer", fontSize = 20.sp, fontWeight = FontWeight.Bold)
                            Text("Android sample", fontSize = 11.sp, color = colors.onSurfaceVariant)
                        }
                        Text("Sample", fontFamily = FontFamily.Monospace, fontSize = 10.sp, color = colors.onSurfaceVariant)
                    }
                    HorizontalDivider(color = colors.outlineVariant)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 8.dp),
                        horizontalArrangement = Arrangement.SpaceBetween) {
                        Text("Test server", fontSize = 11.sp, color = colors.onSurfaceVariant)
                        Text("localhost:$DEFAULT_PORT", fontSize = 10.sp, fontFamily = FontFamily.Monospace,
                            color = colors.onSurfaceVariant)
                    }
                    HorizontalDivider(color = colors.outlineVariant)
                }
            },
            bottomBar = {
                Column(Modifier.background(colors.surface).navigationBarsPadding()) {
                    HorizontalDivider(color = colors.outlineVariant)
                    Column(Modifier.height(dockHeight)) {
                        Row(Modifier.fillMaxWidth().padding(start = 18.dp, end = 8.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text("Activity", fontSize = 12.sp)
                            Spacer(Modifier.weight(1f))
                            TextButton(onClick = { demo.clearLog() }) {
                                Text("Clear", fontSize = 11.sp, color = colors.onSurfaceVariant)
                            }
                        }
                        LazyColumn(state = listState, modifier = Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
                            if (demo.entries.isEmpty()) item {
                                Text("Run an action to see its output.", fontSize = 11.sp, color = colors.onSurfaceVariant)
                            }
                            itemsIndexed(demo.entries) { index, entry ->
                                if (index > 0 && entry.firstOfAction) {
                                    HorizontalDivider(Modifier.padding(vertical = 6.dp), color = colors.outlineVariant)
                                }
                                Row(Modifier.padding(vertical = 3.dp)) {
                                    Text(entry.time, fontFamily = FontFamily.Monospace, fontSize = 10.sp,
                                        color = colors.onSurfaceVariant, modifier = Modifier.padding(end = 10.dp).alignByBaseline())
                                    Text(entry.text, fontFamily = FontFamily.Monospace, fontSize = 11.sp, lineHeight = 17.sp,
                                        modifier = Modifier.alignByBaseline(), color = when (entry.kind) {
                                            LogKind.OK -> if (isSystemInDarkTheme()) Color(0xFF80C2A8) else Color(0xFF267660)
                                            LogKind.ERROR -> colors.error
                                            LogKind.EVENT -> colors.primary
                                            LogKind.INFO -> colors.onSurface
                                        })
                                }
                            }
                        }
                    }
                }
            },
        ) { padding ->
            LazyColumn(Modifier.fillMaxSize().padding(padding).padding(horizontal = 20.dp)) {
                itemsIndexed(demo.sections) { _, section ->
                    Column(Modifier.padding(vertical = 14.dp)) {
                        Row(Modifier.fillMaxWidth().padding(bottom = 10.dp),
                            verticalAlignment = Alignment.CenterVertically) {
                            Text(section.title.replace(" · ", " / "), fontSize = 13.sp, fontWeight = FontWeight.SemiBold,
                                modifier = Modifier.weight(1f))
                            Text("${section.actions.size} actions", fontSize = 10.sp, color = colors.onSurfaceVariant)
                        }
                        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                            section.actions.chunked(4).forEach { actions ->
                                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    actions.forEach { action ->
                                        val primary = action.label == "GET" || action.label == "Connect"
                                        Button(onClick = { demo.run(action) },
                                            modifier = Modifier.weight(1f).height(40.dp),
                                            shape = RoundedCornerShape(7.dp),
                                            border = if (primary) null else BorderStroke(1.dp, colors.outlineVariant),
                                            colors = ButtonDefaults.buttonColors(
                                                containerColor = if (primary) colors.secondaryContainer else colors.surface,
                                                contentColor = when {
                                                    action.label == "Error" -> colors.error
                                                    primary -> colors.primary
                                                    else -> colors.onSurface
                                                }),
                                            contentPadding = PaddingValues(horizontal = 2.dp)) {
                                            Text(action.label, fontSize = 11.sp, fontWeight = FontWeight.SemiBold,
                                                maxLines = 1, textAlign = TextAlign.Center)
                                        }
                                    }
                                    repeat(4 - actions.size) { Spacer(Modifier.weight(1f)) }
                                }
                            }
                        }
                    }
                    HorizontalDivider(color = colors.outlineVariant)
                }
            }
        }
    }
}
