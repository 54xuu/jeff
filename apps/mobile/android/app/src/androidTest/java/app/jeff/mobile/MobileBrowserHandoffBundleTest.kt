package app.jeff.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Checks the signed Android release bundle includes the browser handoff status and actions. */
@RunWith(AndroidJUnit4::class)
class MobileBrowserHandoffBundleTest {
    @Test
    fun releaseBundleIncludesWaitingSiteOriginalConversationAndCancelAction() {
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val bundles = assets.list("public/assets").orEmpty()
            .filter { it.endsWith(".js") && it.startsWith("index") }
        assertTrue("Mobile release JavaScript bundle is missing", bundles.isNotEmpty())
        val source = bundles.joinToString("\n") { name ->
            assets.open("public/assets/$name").bufferedReader().use { it.readText() }
        }
        listOf(
            "mobile-browser-handoff",
            "browser-handoff-open",
            "browser-handoff-cancel",
            "电脑浏览器需要你接管",
            "手机仅显示状态",
        ).forEach { marker -> assertTrue("Release bundle is missing $marker", source.contains(marker)) }
    }
}
