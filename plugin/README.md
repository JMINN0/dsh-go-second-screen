# dsh-go-plugin-mobile —— 一个入口装全部

把 `screen`（虚拟屏+视觉）、`web`（浏览器）、`adb`（设备）三个子插件合成**一个** DSH 插件条目：
**40 个工具 + 胶囊 + 「AI 画面」面板**。

## 为什么

用户反馈插件列表里我们自己的条目太多（4 个）。

## 怎么合并：组合，不重写

```js
for (const [label, spec] of MODULES) {
  const mod = await import(spec);       // 动态 import：一个坏了不影响其它
  const d = await mod.apply(ctx);       // 原样调用，工具名一个不改
  if (typeof d === 'function') disposers.push(d);   // 收集清理函数
}
return async () => { /* 卸载时逐个调 */ };
```

**三个必须做对的点**（对抗审查发现，已修）：

1. **disposer 必须收集并返回** —— `tools.register()` 的 effect 挂在 tools 服务 ctx 上，
   不是插件 fiber。不收集的话热重载后旧工具留着、新的全部注册失败。
2. **必须动态 import** —— 静态 import 时任一子模块顶层报错，整个插件连 try/catch 都进不去。
3. **失败要落到文件** —— 写 `~/.dsh/plugin-screen/mobile-plugin-status.json`，
   不然只能翻引擎 stderr 才能知道哪个子插件挂了。

## 安装

```bash
cd plugin
dsh plugin --profile web add "$PWD"
```

依赖用 `link:` 指向本仓库的 `screen/`、`web/`，以及隔壁的 `dsh-go-plugin-adb` 仓库。

## 注意

`src/watch.js` 是从 `~/.dsh/dsh-go/plugins/local-screen-watch/lib/index.js` 复制的（160 行）。
装了这个之后**要把原来那个原生插件目录删掉**，否则同一进程会注册两个 `strip('watch')` /
`panel('live')`。
