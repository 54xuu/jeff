package app.jeff.mobile

import android.os.SystemClock
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Requires an isolated, actually paired desktop and an ordinary Codex agent.
 * Reopening verifies the value returned by the real encrypted save.
 * The desktop acceptance runner also records the corresponding persisted engine transitions. */
@RunWith(AndroidJUnit4::class)
class MobileEngineSelectionTest {
    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    @Test
    fun phoneEngineSelectionPersistsOnTheConnectedComputer() {
        val name = requireNotNull(InstrumentationRegistry.getArguments().getString("agentName")) { "agentName is required" }
        require(name.none { it == '\'' || it == '\\' }) { "Unsupported agentName selector" }
        click("[data-testid='tab-contacts']")
        click("[data-testid='chat-agent-$name'] button")
        openEditor()
        eventually { assertEquals("codex", evaluate("document.querySelector('[data-testid=mobile-agent-engine]').value")) }
        val agentId = evaluate("document.querySelector('[data-testid=mobile-engine-selector] select[aria-label=智能体]').value")
        require(agentId.matches(Regex("[a-zA-Z0-9_-]+"))) { "Invalid agent ID" }
        try {
            chooseAndSave("opencode")
            assertSavedEngine("opencode")
            openEditor()
            chooseAndSave("codex")
            assertSavedEngine("codex")
        } finally {
            // Restore the test agent after any assertion failure.
            try {
                if (evaluate("String(!!document.querySelector('[data-testid=mobile-engine-selector]'))") != "true") openEditor()
                if (evaluate("document.querySelector('[data-testid=mobile-agent-engine]').value") != "codex") chooseAndSave("codex")
                else click("[data-testid=mobile-engine-selector] button:last-child")
            } catch (_: Throwable) { /* Controller restores the isolated agent if the UI is unavailable. */ }
        }
    }

    private fun openEditor() {
        click("[data-testid='chat-more']")
        click("[data-testid='mobile-engine-settings']")
    }

    private fun chooseAndSave(engine: String) {
        evaluate("(function(){var s=document.querySelector('[data-testid=mobile-agent-engine]');s.value='$engine';s.dispatchEvent(new Event('change',{bubbles:true}));return 'changed'})()")
        eventually { assertEquals(engine, evaluate("document.querySelector('[data-testid=mobile-agent-engine]').value")) }
        click("[data-testid='mobile-engine-save']")
        eventually { assertEquals("false", evaluate("String(!!document.querySelector('[data-testid=mobile-engine-selector]'))")) }
    }

    private fun assertSavedEngine(engine: String) {
        openEditor()
        eventually { assertEquals(engine, evaluate("document.querySelector('[data-testid=mobile-agent-engine]').value")) }
        click("[data-testid=mobile-engine-selector] button:last-child")
    }

    private fun click(selector: String) = eventually {
        onWebView().forceJavascriptEnabled().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick())
    }

    private fun evaluate(script: String): String {
        val result = AtomicReference<String>()
        val latch = CountDownLatch(1)
        activity.scenario.onActivity { current ->
            current.bridge.webView.evaluateJavascript(script) { value -> result.set(value); latch.countDown() }
        }
        assertTrue("WebView evaluation timed out", latch.await(5, TimeUnit.SECONDS))
        return JSONTokener(result.get()).nextValue().toString()
    }

    private fun eventually(assertion: () -> Unit) {
        val deadline = SystemClock.elapsedRealtime() + 30_000
        var last: Throwable? = null
        while (SystemClock.elapsedRealtime() < deadline) {
            try { assertion(); return } catch (error: AssertionError) { last = error }
            catch (error: RuntimeException) { last = error }
            SystemClock.sleep(200)
        }
        throw AssertionError("Real phone/desktop engine selection did not complete", last)
    }
}
