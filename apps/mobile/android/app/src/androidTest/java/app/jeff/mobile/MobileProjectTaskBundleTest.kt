package app.jeff.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Checks the signed release bundle ships the universal task fields and human review controls. */
@RunWith(AndroidJUnit4::class)
class MobileProjectTaskBundleTest {
    @Test
    fun releaseBundleIncludesThreeIndependentTaskFieldsAndReviewActions() {
        val assets = InstrumentationRegistry.getInstrumentation().targetContext.assets
        val bundles = assets.list("public/assets").orEmpty()
            .filter { it.endsWith(".js") && it.startsWith("index") }
        assertTrue("Mobile release JavaScript bundle is missing", bundles.isNotEmpty())
        val source = bundles.joinToString("\n") { name ->
            assets.open("public/assets/$name").bufferedReader().use { it.readText() }
        }
        listOf(
            "mobile-project-task-list",
            "mobile-project-task-title",
            "mobile-project-task-goal",
            "mobile-project-task-description",
            "mobile-project-task-criteria",
            "mobile-project-task-save",
            "mobile-project-task-start",
            "mobile-project-task-approve",
            "验收标准",
            "保存任务",
            "验收通过",
        ).forEach { marker -> assertTrue("Release bundle is missing $marker", source.contains(marker)) }
    }
}
