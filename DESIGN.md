---
name: PalServerConsole
description: 以 ZOE 品牌图形和浅雾蓝交互表面锚定的极简 PalServer 值守台
colors:
  canvas-day: "#fafaf8"
  ink-day: "#2d3132"
  surface-day: "#ffffff"
  border-day: "#e4e7e3"
  mist-blue: "#3d6973"
  mist-blue-hover: "#315862"
  primary-surface: "#eaf1f2"
  primary-ink: "#ffffff"
  running-green: "#47705d"
  danger-coral: "#a34c4a"
  sidebar-day: "#f7f8f5"
  canvas-night: "#1e2222"
  ink-night: "#f2f4f2"
  surface-night: "#272c2b"
  border-night: "#454e4b"
  mist-blue-night: "#a9cdd0"
  danger-coral-night: "#e49a97"
typography:
  display:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "clamp(28px, 3vw, 38px)"
    fontWeight: 750
    lineHeight: 1.12
    letterSpacing: "-0.03em"
  headline:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "25px"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "normal"
  title:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.3
    letterSpacing: "normal"
  body:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: "normal"
  label:
    fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Microsoft YaHei UI", sans-serif'
    fontSize: "12px"
    fontWeight: 650
    lineHeight: 1.4
    letterSpacing: "0.04em"
rounded:
  compact: "6px"
  control: "7px"
  surface: "12px"
  hero: "14px"
  pill: "999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary-surface}"
    textColor: "{colors.mist-blue}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "40px"
  button-quiet:
    backgroundColor: "{colors.surface-day}"
    textColor: "{colors.ink-day}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "40px"
  button-danger:
    backgroundColor: "#f9eceb"
    textColor: "{colors.danger-coral}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 15px"
    height: "40px"
  input-default:
    backgroundColor: "{colors.surface-day}"
    textColor: "{colors.ink-day}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "42px"
  card-default:
    backgroundColor: "{colors.surface-day}"
    textColor: "{colors.ink-day}"
    rounded: "{rounded.surface}"
    padding: "22px"
  status-badge:
    backgroundColor: "{colors.surface-day}"
    textColor: "{colors.ink-day}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "5px 9px"
---

# Design System: PalServerConsole

## Overview

**Creative North Star: "ZOE 晴日值守台"**

PalServerConsole 像一张轻快但可靠的服务器值守台：信息密度高，但每个状态、风险和下一步都有稳定位置。统一配色以近白画布、白色表面、炭灰文字和浅雾蓝交互面为主。ZOE 的粉色与金色主要保留在角色和品牌图形中，让插画成为视觉焦点，而不是把整套界面染成角色服装色。

界面采用白色表面、细边框、低对比阴影和紧凑排布。ZOE 角色图只出现在首页服务器控制模块，ZOE 猫耳图标用于控制台品牌标记、网页 favicon 和 Windows 可执行文件图标。组件应明确可按、状态可辨，并在桌面高密度与手机单列流程之间保持同一套操作语义。

**Key Characteristics:**

- 轻快、简约、清晰的中文运维界面
- 单一浅雾蓝表面承担主要操作与选中状态
- 青绿运行和珊瑚红危险保持稳定的状态语义
- 白色表面、细边框与留白形成近乎无阴影的轻分层
- 桌面侧栏承载高密度操作，手机抽屉与单列布局保留核心流程
- 动效只解释状态变化，并尊重 reduced-motion

## Colors

默认浅色主题使用近白画布、白色表面和浅雾蓝交互面；深色主题使用中性炭黑与提亮雾蓝，保留相同语义而不机械反相。产品只保留这一套颜色语言，不提供页面级配色试选器。

### Primary

- **浅雾蓝：**用于主要操作、选中导航和焦点；默认以浅色表面呈现，文字与图标使用较深雾蓝，避免实心按钮显得厚重。

### Secondary

- **中性灰：**用于次要操作、分隔和数据表面，不与主色争夺注意力。

### Tertiary

- **运行青绿：**用于健康、完成和在线状态；不得代替普通主按钮。
- **危险珊瑚红：**用于失败、破坏性操作和必须处理的错误。

### Neutral

- **日间画布与墨色：**近白配炭灰，保持清爽并避免纯白大面积刺眼。
- **日间表面与边界：**以白色表面和中性灰细边界建立层级。
- **夜间画布与墨色：**中性炭黑配柔和灰白，避免纯黑纯白的生硬反差。
- **夜间表面与边界：**以分级深色表面承载面板、输入框、表格和分区轮廓。

### Named Rules

**The 状态色守位 Rule.** 雾蓝表示主要行动，青绿表示健康或完成，珊瑚红表示危险；具体状态必须同时有文字或图标，不只依赖颜色。

**The 非电竞 Rule.** 可以有能量感，但不要增加大面积霓虹、持续光晕或多色渐变竞争状态信息。

## Typography

**Display Font:** 系统无衬线字体栈，以 `SF Pro Text`、`Segoe UI` 和 `Microsoft YaHei UI` 为主要候选  
**Body Font:** 同一系统无衬线字体栈  
**Label/Mono Font:** 标签沿用系统无衬线；内部 ID 和配置键使用浏览器等宽字体

**Character:** 字体系统以快速扫描和中文可读性为先。层级来自字号、字重和间距，不依赖额外字体下载或夸张大小写。

### Hierarchy

- **Display**（750，响应式 28–38px，1.12）：首页主控制区等少量高层标题。
- **Headline**（700，25px，1.2）：页面标题；手机端收缩至 21px。
- **Title**（700，18px，约 1.3）：面板标题和主要分区标题。
- **Body**（400，14px，1.55）：说明、状态详情与操作上下文。
- **Label**（650，12px，1.4）：状态标签、表头和辅助信息；只在少量短标签中使用轻微字距。

### Named Rules

**The 一屏一主标题 Rule.** 页面只保留一个明确的最高标题；卡片用紧凑标题，不与页面标题争夺层级。

**The ID 后置 Rule.** 玩家、帕鲁、公会和据点优先显示可读名称，内部 ID 使用更小、更弱或等宽样式作为诊断信息。

## Layout

桌面端使用固定 252px 侧栏和最大 1280px 的主内容容器。顶栏保持 sticky，页面内容以 24px 垂直节奏和 22–56px 响应式水平内边距组织；高密度指标采用三列或四列网格，表格与设置区在同一阅读轴上对齐。

1080px 以下先减少监控指标列数；820px 以下配置编辑器改为单列并将分类导航变成横向滚动；760px 以下进入手机布局：侧栏成为抽屉、顶栏降高、页面边距收紧到 18px、多列指标与表格转为单列或卡片化内容。手机端必须保持核心状态、主要操作与风险说明在纵向流程中可完成，不能依赖横向宽屏；可操作控件的触控目标至少为 40px。

**The 密度有序 Rule.** 紧凑不等于挤压；先合并重复状态，再减少装饰，最后才缩小间距。

## Elevation & Depth

系统采用平面分层而不是强悬浮。默认面板以纯白或不透明深色表面、1px 边框和留白建立层级；普通卡片、顶栏和桌面侧栏不使用装饰性阴影。按钮悬停只改变边界与表面，焦点使用独立的三像素半透明当前主色环。顶栏允许轻微 backdrop blur，但信息表格和详情抽屉不使用玻璃模糊。

### Shadow Vocabulary

- **Day Panel**（`0 1px 2px rgb(35 49 50 / 4%)`）：仅在边界不足以分层时使用的微弱阴影。
- **Night Panel**（`0 1px 2px rgb(0 0 0 / 12%)`）：深色主题的微弱表面层次。
- **Structural Sidebar**（`none`）：桌面侧栏依靠完整边界分隔；手机抽屉可由遮罩表达层级。
- **Operation Island**（`0 16px 38px rgb(35 57 61 / 16%)`）：仅用于正在进行的生命周期状态岛。

### Named Rules

**The 轻分层 Rule.** 普通内容依靠表面、边框和间距分层；强阴影只留给固定导航、弹层和当前操作状态。

## Shapes

主要表面使用克制的 12px 圆角，控件使用紧凑 7px 圆角，工具条按钮和提示条可收紧到 6–7px。首页主控制区使用 14px 的略大轮廓；徽章、进度条和动态状态岛使用胶囊形。圆形只用于状态点、头像、图标状态和明确的单一动作。

边框是系统的重要结构语言：默认使用 1px 完整轮廓。危险、警告和健康状态由语义边界、表面、文字与状态点共同表达，不使用左侧或顶部的加粗状态边。不要把所有容器都做成独立卡片；相邻指标可共享外轮廓并用内部 1px 分隔。

**The 语义完整轮廓 Rule.** 状态容器使用 1px 完整语义边界，并由表面、文字和状态点共同表达，不使用 3px 左侧或顶部强调边。

## Components

### Buttons

- **Shape:** 明确可按的紧凑圆角（7px），最小高度 40px。
- **Primary:** 使用浅雾蓝表面、深雾蓝前景和 15px 水平内边距，只用于当前流程的主要动作；不使用渐变或投影。
- **Hover / Focus:** 悬停只略微加强边界和表面；键盘焦点始终显示三像素当前主色焦点环。
- **Secondary / Ghost:** 次要按钮使用白色或深色主题表面与边框；图标按钮保持 40px 方形触控目标。
- **Danger:** 使用浅珊瑚红表面和深红文字，仅用于停止、删除、强制结束或确认覆盖等破坏性动作。

### Chips

- **Style:** 12px 半粗标签、胶囊轮廓和低对比表面。
- **State:** 普通状态使用中性边框；成功、警告和危险变体沿用固定状态语义。筛选选中态使用当前 primary。

### Cards / Containers

- **Corner Style:** 主要表面 12px；首页主控制区 14px。
- **Background:** 浅色使用纯白表面，深色使用对应方案的不透明深色表面，避免多层透明叠加导致发灰。
- **Shadow Strategy:** 默认依靠边界与留白；仅在边界不足以分层时使用一层微弱阴影，密集表格优先共享轮廓而不是逐行投影。
- **Border:** 1px 主题边界；状态型卡片使用完整语义轮廓，并结合表面、文字和状态点表达状态。
- **Internal Padding:** 常规 22–24px，紧凑数据卡 12–16px。

### Inputs / Fields

- **Style:** 42px 高、7px 圆角、强化边框和不透明表面；标签使用 13px 半粗字体。
- **Focus:** 边框切换为当前 primary，并显示三像素焦点环。
- **Error / Disabled:** 错误使用危险珊瑚红文字并保留英文错误标识；禁用态降低透明度但仍保留文字可读性。

### Navigation

桌面端默认使用浅色固定侧栏，四个一级入口采用图标加中文标签。默认项低对比，悬停出现当前 primary 的低饱和表面，当前项使用对应选中底、深色文字和 1px 完整语义轮廓，不使用侧边指示条；深色主题切换为对应方案的深色侧栏。手机端侧栏变为可关闭抽屉，并由 sticky 顶栏中的菜单按钮触发；页面切换后自动关闭。

### Dangerous Confirmation Dialog

停止、封禁和其他危险操作使用模态确认对话框。标题直接说明后果，正文保留目标与可恢复性信息，长路径必须换行且不得超出弹层；取消与确认按钮顺序稳定，破坏性确认使用危险珊瑚红，并保持键盘焦点与至少 40px 的触控目标。

### Responsive Player List

桌面端在线玩家使用共享轮廓表格；手机端改为单列玩家卡片，先显示可读名称，再显示 Player ID 与 IP，踢出和封禁操作并排且各自占满一列。卡片保持 1px 完整边界，长标识允许换行，不通过缩小桌面表格实现适配。

### Operation Island

生命周期状态使用顶部居中的胶囊状态岛。它在倒计时、可取消和等待强制确认时持续可见；实际完成后才自动隐藏。图标、标题、详情和操作按钮保持单行主结构，手机端允许圆角变为 23px 并收紧间距。

## Do's and Don'ts

### Do:

- **Do** 优先合并重复状态，让每个页面只有一个可信状态来源。
- **Do** 用浅雾蓝表面表达行动，用运行青绿和危险珊瑚红表达固定状态语义。
- **Do** 在桌面保持高密度网格，在手机改成安全的纵向流程，并让可操作控件的触控目标至少为 40px。
- **Do** 使用 Lucide 图标、可见焦点、明确状态文字和 reduced-motion。
- **Do** 让 shadcn/ui 组件遵循现有 token、圆角、密度和状态规则，而不是套用默认主题外观。

### Don't:

- **Don't** 把界面做成营销落地页、高亮炫光电竞面板或传统灰白企业后台。
- **Don't** 使用大面积渐变、持续发光或无语义装饰与服务器状态竞争。
- **Don't** 在页面背景使用装饰性网格、光斑或氛围纹理。
- **Don't** 为每条数据创建独立悬浮卡片；优先共享轮廓、表格或紧凑列表。
- **Don't** 用内部 ID、英文配置键或颜色本身代替用户可读名称和状态文字。
- **Don't** 在手机端简单缩小桌面表格；应重排信息和操作顺序。
- **Don't** 使用 3px 左侧或顶部状态强调边；改用 1px 完整语义轮廓、表面、文字和状态点。
