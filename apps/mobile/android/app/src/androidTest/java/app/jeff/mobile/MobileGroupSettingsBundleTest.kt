package app.jeff.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Confirms the signed mobile release APK contains the shipped group-scoped settings controls. */
@RunWith(AndroidJUnit4::class)
class MobileGroupSettingsBundleTest {
    @Test
    fun releaseBundleIncludesGroupRulesAndPerMemberConfigurationControls() {
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val bundles = assets.list("public/assets").orEmpty()
            .filter { it.endsWith(".js") && it.startsWith("index") }
        assertTrue("Mobile release JavaScript bundle is missing", bundles.isNotEmpty())
        val source = bundles.joinToString("\n") { name ->
            assets.open("public/assets/$name").bufferedReader().use { it.readText() }
        }
        listOf(
            "mobile-group-rules",
            "mobile-group-member-select",
            "mobile-group-member-duties",
            "mobile-group-member-model",
            "mobile-group-member-thinking",
            "mobile-group-member-save",
        ).forEach { marker -> assertTrue("Release bundle is missing $marker", source.contains(marker)) }
    }
}
