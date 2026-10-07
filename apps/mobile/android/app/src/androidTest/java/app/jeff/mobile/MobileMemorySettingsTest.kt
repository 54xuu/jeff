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
import org.json.JSONObject
import org.json.JSONTokener
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

/** Runs against the actual paired desktop; saves and rereads via the encrypted IPC. */
@RunWith(AndroidJUnit4::class)
class MobileMemorySettingsTest {
    @get:Rule val activity = ActivityScenarioRule(MainActivity::class.java)

    @Test fun privateMemoryCanBeSearchedSavedAndReopened() {
        val name = requireNotNull(InstrumentationRegistry.getArguments().getString("agentName"))
        click("[data-testid='tab-me']")
        openMemory(name)
        val original = evaluate("document.querySelector('.mobile-memory-settings textarea').value")
        val updated = if (original.isEmpty()) "[私有] MOBILE_MEMORY_11200" else "$original\n§\n[私有] MOBILE_MEMORY_11200"
        try {
            editAndSave(updated)
            click("[data-testid='mobile-memory-close']")
            openMemory(name)
            eventually { assertEquals(updated, evaluate("document.querySelector('.mobile-memory-settings textarea').value")) }
        } finally {
            editAndSave(original)
            click("[data-testid='mobile-memory-close']")
        }
    }

    private fun openMemory(name: String) {
        click("[data-testid='mobile-memory-settings']")
        input(".mobile-memory-settings input", name)
        eventually { assertEquals("1", evaluate("String(document.querySelectorAll('.mobile-memory-scopes button').length)")) }
        click(".mobile-memory-scopes button")
        eventually { assertEquals("true", evaluate("String(!!document.querySelector('.mobile-memory-settings textarea'))")) }
    }
    private fun editAndSave(value: String) {
        input(".mobile-memory-settings textarea", value)
        click("[data-testid='mobile-memory-save']")
        eventually { assertEquals("true", evaluate("String(document.querySelector('[data-testid=mobile-memory-save]').disabled)")) }
    }
    private fun input(selector: String, text: String) {
        evaluate("(function(){var e=document.querySelector(${JSONObject.quote(selector)});var p=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,'value').set.call(e,${JSONObject.quote(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return 'changed'})()")
    }
    private fun click(selector: String) = eventually { onWebView().forceJavascriptEnabled().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick()) }
    private fun evaluate(script: String): String {
        val result = AtomicReference<String>(); val latch = CountDownLatch(1)
        activity.scenario.onActivity { it.bridge.webView.evaluateJavascript(script) { value -> result.set(value); latch.countDown() } }
        assertTrue("WebView evaluation timed out", latch.await(5, TimeUnit.SECONDS))
        return JSONTokener(result.get()).nextValue().toString()
    }
    private fun eventually(assertion: () -> Unit) {
        val deadline = SystemClock.elapsedRealtime() + 30_000; var last: Throwable? = null
        while (SystemClock.elapsedRealtime() < deadline) {
            try { assertion(); return } catch (error: AssertionError) { last = error } catch (error: RuntimeException) { last = error }
            SystemClock.sleep(200)
        }
        throw AssertionError("Real memory operation did not complete", last)
    }
}
