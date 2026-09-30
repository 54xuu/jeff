package app.jeff.mobile;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(JeffSpikePlugin.class);
        super.onCreate(savedInstanceState);
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[] {"android.permission.POST_NOTIFICATIONS", "android.permission.CAMERA"}, 1);
        }
        ContextCompat.startForegroundService(this, new Intent(this, RelayForegroundService.class));
        // 电池优化豁免不再冷启动强制弹窗（弹窗期间应用完全不可交互）：
        // 改由 JS 在「已绑定电脑」后调 JeffSpike.requestBattery()，已授权时静默跳过。
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    public void onBackPressed() {
        if (JeffSpikePlugin.Companion.getInstance() != null) {
            JeffSpikePlugin.Companion.getInstance().dispatchBack();
            return;
        }
        super.onBackPressed();
    }
}
