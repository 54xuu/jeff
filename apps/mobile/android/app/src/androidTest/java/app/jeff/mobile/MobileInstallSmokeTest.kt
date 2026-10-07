package app.jeff.mobile

import android.content.pm.ActivityInfo
import android.content.res.Configuration
import android.os.SystemClock
import androidx.test.espresso.web.webdriver.DriverAtoms.getText
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import androidx.test.espresso.web.assertion.WebViewAssertions.webMatches
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.ext.junit.rules.ActivityScenarioRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.hamcrest.Matchers.not
import org.junit.Rule
import org.junit.Test
import org.junit.Before
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class MobileInstallSmokeTest {
    @get:Rule
    val activity = ActivityScenarioRule(MainActivity::class.java)

    @Before
    fun waitForInstalledInterface() {
        waitForJeffInterface()
    }

    private fun waitForJeffInterface() {
        val deadline = SystemClock.elapsedRealtime() + 30_000
        var lastFailure: Throwable? = null
        while (SystemClock.elapsedRealtime() < deadline) {
            try {
                onWebView().forceJavascriptEnabled()
                    .withElement(findElement(Locator.CSS_SELECTOR, "#root main"))
                    .check(webMatches(getText(), not(org.hamcrest.Matchers.isEmptyOrNullString())))
                return
            } catch (error: AssertionError) {
                lastFailure = error
            } catch (error: RuntimeException) {
                lastFailure = error
            }
            SystemClock.sleep(200)
        }
        throw AssertionError("Installed Jeff did not render its interface within 30 seconds", lastFailure)
    }

    @Test
    fun installedAppLoadsItsWebViewAndRendersTheJeffInterface() {
        onWebView().forceJavascriptEnabled()
            .withElement(findElement(Locator.TAG_NAME, "body"))
            .check(webMatches(getText(), not(org.hamcrest.Matchers.isEmptyOrNullString())))


        activity.scenario.onActivity { current -> check(!current.isFinishing) }
    }

    @Test
    fun installedAppSupportsLandscapeRotationWithoutLeavingTheChatWebView() {
        activity.scenario.onActivity { current ->
            current.requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        }
        InstrumentationRegistry.getInstrumentation().waitForIdleSync()
        activity.scenario.onActivity { current ->
            assertEquals(Configuration.ORIENTATION_LANDSCAPE, current.resources.configuration.orientation)
        }
        onWebView().forceJavascriptEnabled()
            .withElement(findElement(Locator.TAG_NAME, "body"))
            .check(webMatches(getText(), not(org.hamcrest.Matchers.isEmptyOrNullString())))
        val measured = AtomicReference<String>()
        val ready = CountDownLatch(1)
        activity.scenario.onActivity { current ->
            current.bridge.webView.evaluateJavascript(
                "(function(){var shell=document.querySelector('main.shell');return !!shell && shell.getBoundingClientRect().height >= window.innerHeight - 2;})()"
            ) { value -> measured.set(value); ready.countDown() }
        }
        assertTrue("WebView viewport measurement timed out", ready.await(10, TimeUnit.SECONDS))
        assertEquals("Landscape workspace must fill the viewport", "true", measured.get())
    }

    @Test
    fun installedNavigationOpensContactsAndProfile() {
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='tab-contacts']"))
            .perform(webClick())
            .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='contacts-list']"))
            .check(webMatches(getText(), not(org.hamcrest.Matchers.isEmptyOrNullString())))
        onWebView()
            .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='tab-me']"))
            .perform(webClick())
            .withElement(findElement(Locator.CSS_SELECTOR, "[data-testid='me-profile']"))
            .check(webMatches(getText(), not(org.hamcrest.Matchers.isEmptyOrNullString())))
    }
}
