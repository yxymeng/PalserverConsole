# 流岚 · FlowMist

让进度如云舒卷。一个可复用的 WebGL 云团进度条，提供原生 JavaScript 和 React 接口。

保留局部翻卷、纵深云层、柔和不规则进度边缘，以及已经调整的配色关系。只提供云团运动；柔和云团和细碎颜料是纹理选项。主色、强调色、高光和主题暗部独立控制，避免色彩平均后发灰。这是程序生成的视觉近似，并非物理流体求解器。

## 本地使用

不需要构建，也不依赖 npm 注册表发布。源码包解压到其他项目旁边后，在目标项目执行：

```sh
npm install ../FlowMist
```

仓库：https://github.com/yxymeng/FlowMist （私有）。在已配置 GitHub SSH 访问的电脑上，也可以直接安装：

```sh
npm install git+ssh://git@github.com/yxymeng/FlowMist.git
```

当前包设置 `private: true`，防止误发到 npm 公共注册表。

## React / PalserverConsole

在 PalserverConsole 的 `frontend` 中安装包，然后使用：

```tsx
import { FlowMist } from '@yxymeng/flowmist/react';
import '@yxymeng/flowmist/style.css';

export function DownloadProgress({ percent }: { percent: number }) {
  return <FlowMist value={percent} palette="CELADON" label="下载进度"
    style={{ height: 64 }} />;
}
```

接口面向 React 18 / 19。组件将值限制在 0–100，提供进度无障碍属性；渲染初始化失败时显示静态进度。卸载时自动释放 GPU 资源和监听器。SSR 导入不访问浏览器对象，绘制在客户端 effect 中初始化。尚未在 PalserverConsole 中实际集成测试。

## 原生 JavaScript

```html
<link rel="stylesheet" href="./node_modules/@yxymeng/flowmist/src/style.css">
<div class="flowmist" role="progressbar" aria-label="下载进度"
     aria-valuemin="0" aria-valuemax="100" aria-valuenow="35">
  <canvas aria-hidden="true"></canvas>
</div>
<script type="module">
  import { createFlowMist } from './node_modules/@yxymeng/flowmist/src/index.js';
  const host = document.querySelector('.flowmist');
  const progress = createFlowMist(host.querySelector('canvas'), {value: 35, palette: 'OCEAN'});
  function update(value) {
    const safe = Math.min(100, Math.max(0, value));
    progress.update({value: safe});
    host.setAttribute('aria-valuenow', String(safe));
  }
  // 离开页面或移除组件时：progress.destroy();
</script>
```

原生接口仅管理 canvas，业务文字、无障碍属性和失败回退由调用方管理。

## 参数

| 参数 | 默认值 | 含义 |
| --- | --- | --- |
| `value` | `0` | 0–100 的有限数值，越界自动截断 |
| `palette` | `ORIGINAL` | 下表中的稳定配色代码 |
| `detail` | `0` | 0 柔和云团；1 细碎颜料 |
| `paused` | `false` | 停止云团运动，进度更新立即生效 |
| `pixelRatio` | `1.25` | 像素比例上限，允许大于 0 且不超过 2 |
| `onError` | — | 接收 WebGL 错误；原生初始化失败直接抛错 |
| `label` | `进度` | React 专属，业务文字及无障碍名称 |
| `className`, `style` | — | React 专属，定制容器样式 |

`createFlowMist` 返回 `update(options)` 和 `destroy()`。`onError` 在初始化时设置，不能通过 `update` 更换。包还导出只读 `palettes` 和 `getPalette(code)`。

## 配色

| 代码 | 名称 | 色彩关系 | 分组 |
| --- | --- | --- | --- |
| ORIGINAL | 杏霞 | 杏橙 / 洋红 / 乳白 | 经典 |
| OCEAN | 蓝汐 | 清蓝 / 紫 / 冰白 | 经典 |
| KLEIN | 钴焰 | 钴蓝 / 橙 / 深蓝暗部 | 经典 |
| ULTRAVIOLET | 紫萤 | 淡紫 / 黄绿 / 柔白 | 经典 |
| CHROME | 银雾 | 银灰 / 石墨 / 冷白 | 经典 |
| PLUS | 落照 | 橙 / 珊瑚红 / 奶油白 | 经典 |
| CELADON | 碧瓷 | 青绿 / 浅瓷绿 / 玉白 | 推荐试色 |
| ROSE | 绛雪 | 玫红 / 深绛 / 雪白 | 推荐试色 |
| MOONSAND | 月砂 | 靛蓝 / 香槟砂 / 暖白 | 推荐试色 |
| PINE | 松影 | 灰松绿 / 深绿 / 米白 | 推荐试色 |

展示名与程序代码分离；例如 `OCEAN` 只是蓝汐配色，不代表海浪运动。

## 演示与验证

```sh
npm run demo
# 浏览器打开 http://127.0.0.1:4173/demo/
npm test
npm pack --dry-run
```

核心不需要第三方运行时依赖；React 由宿主项目提供。演示命令需要 Python 3。

默认约 25 fps，像素比例上限 1.25；系统开启减少动态效果时停止动画，但仍能更新进度。后台标签页停止动画调度。WebGL context 丢失后等待恢复；不可恢复时建议调用方通过 `onError` 展示提示。每个实例有自己的 WebGL context，适合少量重点进度条，不适合未经性能测试直接用于大型列表。

沿用参考效果的左侧白色渐隐，因此低进度时颜色偏淡，文字百分比用于精确读数。需要 WebGL 1、片元 highp、ResizeObserver 及现代浏览器。

测试覆盖参数、暂停、端点数值、减少动态效果、后台调度、context 恢复和释放/重建；GPU 使用 mock，这些测试不证明着色器实际编译或视觉质量。当前环境未完成真实浏览器 GPU 验证，接入前请在目标浏览器打开演示检查。
