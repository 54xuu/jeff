// React 19 的 act() 只在测试环境标志打开时刷新 effect。
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
