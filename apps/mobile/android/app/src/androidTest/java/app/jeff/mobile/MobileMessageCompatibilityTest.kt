package app.jeff.mobile

import android.os.SystemClock
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.hamcrest.Matchers.containsString
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Requires a real paired desktop and a committed model reply. No fixture is
 * inserted into the WebView: opening history exercises the installed renderer. */
@RunWith(AndroidJUnit4::class)
class MobileMessageCompatibilityTest {
    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun installedAppRendersTheActualEncryptedModelReply() {
        val args = InstrumentationRegistry.getArguments()
        val name = requireNotNull(args.getString("agentName")) { "agentName is required" }
        val marker = requireNotNull(args.getString("replyMarker")) { "replyMarker is required" }
        require(name.none { it == '\'' || it == '\\' }) { "Unsupported agentName selector" }
        eventually {
            onWebView().forceJavascriptEnabled()
                .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='tab-contacts']"))
                .perform(webClick())
        }
        eventually {
            onWebView()
                .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='chat-agent-$name'] button"))
                .perform(webClick())
        }
        eventually {
            onWebView()
                .withElement(findElement(Locator.CSS_SELECTOR, ".wechat-ai-body"))
                .check(webMatches(getText(), containsString(marker)))
        }
    }

    private fun eventually(assertion: () -> Unit) {
        val deadline = SystemClock.elapsedRealtime() + 30_000
        var last: Throwable? = null
        while (SystemClock.elapsedRealtime() < deadline) {
            try { assertion(); return } catch (error: AssertionError) { last = error }
            catch (error: RuntimeException) { last = error }
            SystemClock.sleep(200)
        }
        throw AssertionError("Installed reply did not render within 30 seconds", last)
    }
}
