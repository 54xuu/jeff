package app.jeff.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Confirms the signed mobile release APK ships project-scoped SiYuan destination controls. */
@RunWith(AndroidJUnit4::class)
class MobileSiyuanSettingsBundleTest {
    @Test
    fun releaseBundleIncludesProjectNotebookAndParentDocumentBinding() {
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val bundles = assets.list("public/assets").orEmpty()
            .filter { it.endsWith(".js") && it.startsWith("index") }
        assertTrue("Mobile release JavaScript bundle is missing", bundles.isNotEmpty())
        val source = bundles.joinToString("\n") { name ->
            assets.open("public/assets/$name").bufferedReader().use { it.readText() }
        }
        listOf(
            "project-siyuan-target",
            "mobile-group-siyuan-notebook",
            "mobile-group-siyuan-parent",
            "思源知识库位置",
        ).forEach { marker -> assertTrue("Release bundle is missing $marker", source.contains(marker)) }
    }
}
