/** 六个工具的契约。 */
const out = (d) => ({
  schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true, description: d } } },
  render(_a, v) { return [{ type: 'text', text: v.text }]; },
});

const MODES = [
  '四种操作方式，按任务选（都不许影响主屏）：',
  '1) shell  —— adb 直接执行，最快最稳，零打扰。装包、看日志、查状态、改设置都用它。',
  '2) browser —— 走 CDP 操作浏览器，不点屏幕。只在需要网页交互时用。',
  '3) vdisplay —— 私有虚拟屏，App 跑在用户看不见的屏上，可以截图+定向点击。需要"看界面再点"的 App 操作用它。',
  '4) watch  —— 用户想看你操作时，把虚拟屏截图发上来。',
].join('\n');

export function modesSpec() {
  return {
    name: 'screen_modes',
    description: ['列出目前可用的操作方式以及各自的代价与适用场景，供你选择。', '', MODES].join('\n'),
    parameters: {},
    output: out('四种方式的对比表与选择建议。'),
  };
}

export function startSpec() {
  return {
    name: 'vdisplay_start',
    description: [
      '创建一块用户看不见的私有虚拟屏（headless virtual display），App 可以跑在上面。',
      '',
      '关键性质（都实测过）：不画在物理屏幕上、不抢主屏焦点、不弹输入法。',
      '需要这台机器的 com.android.shell 拥有 ADD_TRUSTED_DISPLAY 权限（一部分机型有，Pixel 默认没有）。',
      '',
      '屏与插件进程同生共死：客户端断开或引擎重启，屏自动消失，不会留垃圾。',
    ].join('\n'),
    parameters: {
      keepMin: { type: 'integer', description: '**按任务预估后台屏要活多久**（分钟，1~360）。不传沿用当前设定（默认 5）。长任务（挂机/轮询/等转盘）先设大，比如 60；点几下就完的设 3。AI 连续这么多分钟没调工具就自动关闭。' },
      maxFps: {
        type: 'integer',
        description: '视频流帧率上限，默认 60。传 0 表示不限。'
          + '以前没这个参数等于无限帧率，实测 3D 游戏会跑到 145fps，白烧 CPU 和带宽。',
      },
      width: { type: 'integer', description: '宽度，默认 720。' },
      height: { type: 'integer', description: '高度，默认 1280。' },
      dpi: { type: 'integer', description: '密度，默认 320。' },
      orientation: { type: 'string', description: '方向："portrait"（竖屏，确保高>宽）、"landscape"（横屏，确保宽>高）。省略时按给定的 width/height 创建。landscape 时如果 width<height 会自动交换。' },
      systemDecorations: { type: 'boolean', description: '默认 false。false 时虚拟屏上不含二级桌面、导航栏和权限弹窗，AI 截图更干净（scrcpy ≥3.1）。改这个值会重建屏。' },
      hwc: { type: 'string', description: '是否让硬件合成器（HWC）参与虚拟屏合成。"auto"（默认）：仅当本机 vendor.display.vds_allow_hwc=1 时自动开启；"on"：强制尝试；"off"：不碰。开启后 3D 游戏（SurfaceView 渲染）能正常出画面，否则全黑。这是全局 SurfaceFlinger 属性，stop 时会恢复原值。' },
    },
    output: out('displayId、SurfaceFlinger id、是否具备托管 App 的能力标志。'),
  };
}

export function launchSpec() {
  return {
    name: 'vdisplay_launch',
    description: [
      '把一个 App 投到虚拟屏上，而不是主屏。',
      '',
      '内部会先 force-stop 该 App：如果它已经在主屏后台跑着，直接投屏只会把旧任务拉到前台，',
      '就会顶掉用户正在看的东西（实测踩过）。投完会**校验并报告**主屏焦点变没变，',
      '但**不会自动还原** —— 自动还原会误判（用户自己切了 App 时插件反而去改主屏），',
      '所以只观察、只报告，由你决定要不要处理。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，例如 com.tencent.mm。' },
      activity: { type: 'string', description: 'Activity 名，例如 .ui.LauncherUI。省略则只给包名。' },
    },
    output: out('是否成功落在虚拟屏上、主屏前后焦点对比。'),
  };
}

export function inputSpec() {
  return {
    name: 'vdisplay_input',
    description: [
      '往虚拟屏定向注入输入：点击、滑动、输入文字、按键。',
      '',
      '这些事件只发给虚拟屏，不会落到主屏上。虚拟屏上不弹软键盘（为了不抢你的键盘），所以：',
      '',
      '- kind:"text"：往标准输入框注入文字。系统设置、原生控件一般有效；',
      '  自绘输入框（京东、部分 App 的搜索框）可能注不进去。',
      '- kind:"paste"：发 KEYCODE_PASTE，把**剪贴板**内容粘进当前输入框。',
      '  这条路不经过输入法，对自绘输入框也有效，是 text 失败时的首选替代。',
      '  带 text 时插件会先写剪贴板再粘，支持中文；不带 text 则粘用户剪贴板里现有的内容。',
      '- kind:"key"：发按键，如 KEYCODE_BACK / KEYCODE_ENTER。',
    ].join('\n'),
    parameters: {
      kind: { type: 'string', required: true, description: 'tap | swipe | hold | text | key | paste。hold = 按住不动（游戏摇杆、长按菜单、持续挖方块），走 scrcpy 控制通道发 60Hz 连续 MOVE，实测比固定 14 步的 swipe 稳得多（后者 5 秒长按会退化成 3Hz，游戏当手指没动）。' },
      ms: { type: 'integer', description: '时长毫秒。swipe 默认 300（滑动的快慢）；hold 默认 1000（按住的时长，长按菜单 800-1500，持续挖方块 3000-8000）。' },
      jitter: { type: 'integer', description: 'hold：手指位置抖动幅度（逻辑像素），默认 2。真按不会绝对静止，设 0 会变成机器特征。' },
      driftX: { type: 'integer', description: 'hold：按住期间缓慢横向漂移（逻辑像素），默认 0。摇杆往右推就设正数（比如 40）。' },
      driftY: { type: 'integer', description: 'hold：按住期间缓慢纵向漂移，默认 0。摇杆往前推设负数（屏幕坐标 y 向下）。' },
      verify: { type: 'boolean', description: '默认 true：动作前后各取一次画面哈希，没变就返回"可能没生效"。传 false 跳过校验，实测省约 2 秒（两次 screencap 各约 1 秒），适合连续点同一界面。' },
      settleMs: { type: 'integer', description: '动作后等画面稳定的毫秒数，默认 500。' },
      shotAfter: { type: 'boolean', description: '动作后顺手截一张并返回路径（省掉单独调 vdisplay_shot 的一轮往返）。默认 false。' },
      width: { type: 'integer', description: 'shotAfter 时的截图宽度，默认 540。' },
      text: { type: 'string', description: 'kind:"text" 要注入的 ASCII 文字；或 kind:"paste" 要粘贴的文字（**支持中文**，插件会先写剪贴板再粘）。paste 不带 text 时粘现有剪贴板内容。注意剪贴板是系统全局的，写它会覆盖用户自己的剪贴板。' },
      x: { type: 'integer', description: 'tap 的 x 像素坐标（和 nx 二选一）。' },
      y: { type: 'integer', description: 'tap 的 y 像素坐标（和 ny 二选一）。' },
      nx: { type: 'number', description: '归一化横坐标 0..1，按屏宽换算。比算像素省心，推荐用它。' },
      ny: { type: 'number', description: '归一化纵坐标 0..1，按屏高换算。' },
      x1: { type: 'integer', description: 'swipe 起点 x。' },
      y1: { type: 'integer', description: 'swipe 起点 y。' },
      x2: { type: 'integer', description: 'swipe 终点 x。' },
      y2: { type: 'integer', description: 'swipe 终点 y。' },
      key: { type: 'string', description: 'kind=key 时的按键名，例如 KEYCODE_BACK。' },
    },
    output: out('注入结果。'),
  };
}

export function shotSpec() {
  return {
    name: 'vdisplay_shot',
    description: [
      '看虚拟屏。frames=1 给一张静态截图；frames>1 连拍几张拼成网格，用来看「在动吗、往哪动、变成什么样」。',
      '',
      'frames=1（默认）：一张截图，能读屏幕上的字和数字。720x1592 竖屏缩到 420 宽约 230 token、540 宽约 377。',
      '',
      'frames>1：抓 N 帧拼成网格，从左到右、从上到下是时间顺序。',
      '九格缩到每格 262 宽后，原图 26px 的字只剩 9px —— 只能看结构、位置、有没有动，读不出小字。',
      '形状会按屏幕真实比例自动算：竖屏画布是竖的，横屏（游戏）画布是横的。',
      '',
      '成本（720x1592 竖屏、9 帧 3x3 实测）：每格 160 → 312 token；180 → 377；200 → 480；262 → 798；300 → 1056。',
      '只想判断动没动用 160-180（312-377 token）；想顺便看清大字用 262（798 token）。',
      '',
      '看不清某个按钮或数字时，用 region 只截那一块 —— 比调大 width 更划算：'
        + '同样 420 宽，局部 1.167x（放大），全屏 0.583x（缩小），而且局部只要 180 token、全屏要 684。',
    ].join('\n'),
    parameters: {
      frames: {
        type: 'integer',
        description: '抓几帧。1（默认）= 单张截图；2/4/6/9/12/16 = 拼成网格。会被规整成能拼成矩形的数。',
      },
      width: {
        type: 'integer',
        description: '每帧宽度。frames=1 时默认 540（读字用）；frames>1 时默认 262（看运动用）。范围 240-720。',
      },
      intervalMs: {
        type: 'integer',
        description: 'frames>1 时的帧间隔毫秒，默认 300。抓快动作调小（最小 0），抓慢变化调大。',
      },
      format: { type: 'string', description: 'frames=1 时有效："jpeg"（默认，省 token）或 "png"。' },
      region: {
        type: 'object',
        // **必须显式声明 additionalProperties**，否则宿主拒绝整个工具的注册：
        //   register failed: unsupported JSON schema:
        //   parameters.region.additionalProperties must be explicitly true or false
        // 诊断日志 dsh-app/diagnostics.md:62 和 :122 两次报过这个。
        // 后果：vdisplay_shot 这个核心工具一直没注册上，工具列表里少一个。
        additionalProperties: false,
        properties: {
          x: { type: 'integer', description: '左上角 x（显示逻辑像素）' },
          y: { type: 'integer', description: '左上角 y' },
          w: { type: 'integer', description: '宽' },
          h: { type: 'integer', description: '高' },
        },
        description: '只看屏幕的一块：{x,y,w,h}，坐标用显示逻辑像素（跟 x/y 点按同一套坐标）。把这块按 width 交付，等于放大。'
          + '实测：取 360×796 的局部交付到 420 宽，只要 180 token（全屏要 684），而线性分辨率是全屏的 2 倍。'
          + '看不清某个按钮/数字时用这个，比调大 width 划算。',
      },
      crop: {
        type: 'string',
        description: '已废弃，传了也不裁。原因：浏览器壳在顶部还是底部拿不到可靠信号（实测顶部还会有翻译条），'
          + '自动裁会把真实内容切掉。想看细节请用 region。',
      },
      dir: { type: 'string', description: '输出目录，默认 /tmp。' },
    },
    output: out('图片路径、格数、每格大小、是否和上次一样。'),
  };
}

export function mainShotSpec() {
  return {
    name: 'screen_shot_main',
    description: [
      '截主屏（用户正在看的屏幕）。只读操作，不会改变任何东西。',
      '',
      '用途：确认用户现在在看什么，或核对"我刚才的操作有没有影响主屏"。',
    ].join('\n'),
    parameters: {
      dir: { type: 'string', description: '本地保存目录，默认 /tmp。' },
      width: { type: 'integer', description: '输出宽度，默认 540（实测文字仍清晰，token 省约 44%）。范围 240–1080。' },
      format: { type: 'string', description: '"jpeg"（默认，省 token）或 "png"（需要无损时）。' },
    },
    output: out('截图路径，以及当前主屏焦点是哪个 App。'),
  };
}

export function statusSpec() {
  return {
    name: 'vdisplay_status',
    description: ['查看虚拟屏状态：是否在跑、displayId、上面跑着哪个 App、主屏现在是什么。'].join('\n'),
    parameters: {},
    output: out('状态摘要。'),
  };
}

export function stopSpec() {
  return {
    name: 'vdisplay_stop',
    description: ['销毁虚拟屏，释放资源。收工时应调用——虽然是自动生命周期的，但显式停更干净。'].join('\n'),
    parameters: {
      forceStopApps: { type: 'boolean', description: '默认 false。传 true 会 force-stop 投上去过的 App，清掉后台占用；DSH 和 Shizuku 会被自动跳过（杀了会影响用户）。' },
    },
    output: out('销毁结果。'),
  };
}

export function streamStartSpec() {
  return {
    name: 'vdisplay_stream',
    description: [
      '把虚拟屏的画面以低帧率 JPEG 推给 DSH Go 的「AI 画面」胶囊，用户点它就能实时看到 AI 在操作什么。',
      '',
      '实测成本：360x640 @2fps 约 0.30 核、29 KB/s，全程不写任何文件。帧率上限 15fps。',
      '不看的时候胶囊不显示画面；调 vdisplay_stream_stop 或 vdisplay_stop 就会完全停掉。',
    ].join('\n'),
    parameters: {
      fps: { type: 'integer', description: '帧率，1–4，默认 2。' },
      width: { type: 'integer', description: 'JPEG 宽度，240–720，默认 360。' },
    },
    output: out('端口、帧率与打开方式。'),
  };
}

export function streamStopSpec() {
  return {
    name: 'vdisplay_stream_stop',
    description: '停止推流。',
    parameters: {},
    output: out('结果。'),
  };
}

export function textSpec() {
  return {
    name: 'vdisplay_text',
    description: [
      '把虚拟屏上的文字识别成文本，带坐标返回。**这是读数字和文字最可靠的方式，而且不花图片 token。**',
      '',
      '什么时候该用：要读屏幕上的数字、金额、时间、列表文字、按钮文字、输入框内容时。',
      '实测：把截图缩成九格后，原图 26px 的字只剩 5px，模型读不出还会编造 —— 所以数字一律走这个工具。',
      '',
      '返回每行文字 + 像素坐标 + 归一化坐标（nx/ny，可直接给 vdisplay_input 点按）+ 置信度。',
      '图像没变化时会直接复用上次结果，不重新识别。',
      '',
      '成本：约 1.6 秒（首次要 3-5 秒加载模型），**0 图片 token**。',
    ].join('\n'),
    parameters: {
      minConf: {
        type: 'number',
        description: '置信度下限，默认 0.45。调高（如 0.8）只留很确定的，调低会带噪声进来。',
      },
      maxLines: {
        type: 'integer',
        description: '最多返回几行，默认 80。屏幕文字多时截断（按从上到下、从左到右）。',
      },
      fresh: {
        type: 'boolean',
        description: '强制重新识别，默认 false（画面没变就复用缓存）。',
      },
    },
    output: out('识别到的文字行（含坐标和置信度）。'),
  };
}

export function appsSpec() {
  return {
    name: 'vdisplay_apps',
    description: [
      '列出手机上的第三方 App（名称 + 包名），投屏前拿来查包名。',
      '',
      '为什么要这个工具：vdisplay_launch 要包名，但之前没有任何工具能告诉你包名是什么，',
      '模型只能靠猜。这个工具补上这一环 —— 列的是 `pm list packages -3`（第三方），',
      '系统应用不列，因为投系统应用基本没意义。',
    ].join('\n'),
    parameters: {},
    output: out('已安装第三方 App 的包名列表。'),
  };
}

export function poolSpec() {
  return {
    name: 'screen_pool',
    description: [
      '看当前有几块后台屏、哪块是活动屏。',
      '',
      '后台屏是这么回事：每个会话可以有自己的屏，屏上跑自己的 App，互不干扰。',
      '实测两块屏可以同时跑不同 App（一块设置、一块文件管理器），切换不打扰对方。',
      '',
      '注意：**所有 vdisplay_* 操作作用在「活动屏」上**，切换用 screen_use。',
    ].join('\n'),
    parameters: {},
    output: out('屏列表、活动屏、每块的 displayId 和 dpi。'),
  };
}

export function newScreenSpec() {
  return {
    name: 'screen_new',
    description: [
      '新建一块后台屏，返回它的 screenId。',
      '',
      '什么时候用：需要一块干净的屏、或需要同时让两个 App 各自独立跑。',
      '注意屏幕数量受手机资源限制 —— 每块屏约 75-185MB 内存，实测两块很轻松，',
      '4-6 块要看你手机上跑的 App 有多重。',
    ].join('\n'),
    parameters: {
      orientation: { type: 'string', description: '"portrait" 或 "landscape"。省略按物理屏比例。' },
      hwc: { type: 'string', description: '"auto"（默认）/"on"/"off"。3D 游戏要开。' },
    },
    output: out('新建屏的 screenId、displayId、dpi。'),
  };
}

export function useScreenSpec() {
  return {
    name: 'screen_use',
    description: [
      '切换活动屏。之后所有 vdisplay_* 操作都作用在这块屏上。',
      '',
      '典型用法：screen_new 建一块 → screen_use 切过去 → vdisplay_launch 投 App。',
      '切回来不会打扰另一块屏上的 App —— 实测各自状态都保留。',
    ].join('\n'),
    parameters: {
      screenId: { type: 'string', required: true, description: 'screenId，比如 "sd-1"。来自 screen_new 或 screen_pool。' },
    },
    output: out('切换结果。'),
  };
}

export function closeScreenSpec() {
  return {
    name: 'screen_close',
    description: [
      '销毁一块后台屏，释放它的内存和上面的 App。',
      '',
      '注意：**屏一销毁，上面的 App 就没了**，下次要用得重新投。',
      '如果只是想切走，用 screen_use，不用关屏。',
    ].join('\n'),
    parameters: {
      screenId: { type: 'string', required: true, description: '要销毁的 screenId。' },
      forceStopApps: { type: 'boolean', description: '默认 false。true 时同时 force-stop 屏上的 App。' },
    },
    output: out('销毁结果。'),
  };
}

export function checkAppSpec() {
  return {
    name: 'screen_check_app',
    description: [
      '查某个 App 现在被谁占着 —— 主屏用户在用它？还是别的屏上的 AI 在用？还是没人用？',
      '',
      '投屏前先查这个，避免把人正在用的 App 抢走（实测：`am start --display` 对',
      'singleTask 的 App 会把主屏任务直接搬走，用户那一下就没了）。',
      '',
      '返回等级：FREE 没人用 / USER_BG 用户主屏后台有 / USER_ACTIVE 用户正在看着',
      '（**绝对不能碰**）/ AI_HELD 在我们自己屏上 / FOREIGN 外来屏（不碰）。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，比如 "com.android.settings"。用 vdisplay_apps 查。' },
    },
    output: out('占用等级和详细情况。'),
  };
}

export function claimAppSpec() {
  return {
    name: 'screen_claim_app',
    description: [
      '申请占用一个 App。拿到了才能安全地在它上面操作，别人再申请会失败。',
      '',
      '**默认不抢占**（onConflict 默认 fail）。这是故意的：默认抢占会让多 AI 互相抢，',
      '默认失败才逼出「先查再决定」。',
      '',
      '三种冲突处理：',
      "  fail    直接失败，告诉你谁占着（默认）",
      "  wait    返回还要等多久",
      "  preempt 强制接管 —— 原持有者下次调用会收到撤销通知",
      '',
      '**重要**：宽限期只有 5 秒，而一轮 AI 往返 6-9 秒，所以「让原持有者体面收尾」',
      '在物理上做不到。preempt 能保证的只有「它不会继续误操作」。',
      '',
      '登录、支付、发送这类操作请传 preemptible:false，别人就抢不走了。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名。用 vdisplay_apps 查。' },
      onConflict: { type: 'string', description: "'fail'（默认）/ 'wait' / 'preempt'" },
      preemptible: { type: 'boolean', description: '默认 true。设 false 表示谁都抢不走（登录取证、支付中）。' },
      nonPreemptibleReason: { type: 'string', description: 'preemptible:false 时说明原因，比如"正在登录"。' },
      priority: { type: 'string', description: "'user' / 'agent'（默认）/ 'subagent'。高优先级能抢低的。" },
      ttlSec: { type: 'integer', description: '租约时长秒数，默认 600（10 分钟）。' },
      mode: { type: 'string', description: "'exclusive'（默认）/ 'readonly'" },
    },
    output: out('租约信息，或者冲突详情。'),
  };
}

export function releaseAppSpec() {
  return {
    name: 'screen_release_app',
    description: [
      '释放 App 占用。干完了主动放，别人就能用了。',
      '',
      '不传 leaseId 时释放自己持有的全部租约。',
    ].join('\n'),
    parameters: {
      leaseId: { type: 'string', description: '要释放的租约 id。省略则释放当前会话全部的。' },
    },
    output: out('释放结果。'),
  };
}

export function leasesSpec() {
  return {
    name: 'screen_leases',
    description: '看当前所有 App 占用凭证（谁占着什么、还剩多久、能不能抢）。',
    parameters: {},
    output: out('租约列表。'),
  };
}

/* ============================================================
 * 感知层工具定义（2026-11-16）
 *
 * 对应的实现在 tools.js：live / liveShot / waitStable / roi / probeSecure。
 * 这些能力在 vd.js 里已经真机验证过，之前只是没暴露给工具层。
 * ============================================================ */

export function liveSpec() {
  return {
    name: 'vdisplay_live',
    description: [
      '视频流的常驻解码器：启动 / 停止 / 看状态。',
      '',
      '为什么值得开：常驻之后读一帧是内存拷贝（<1ms）；不开的话每次都要按需解码（约 244ms）。',
      '',
      '**重要限制**：scrcpy 只在画面变化时发帧。画面静止时一个包都不发，读不到画面是正常的。',
      '要一张确定的静止帧，用 vdisplay_shot（走 screencap）。',
      '',
      '实测：GIF/动画能跑 60fps；但**视频（MediaCodec 输出）在虚拟屏上不刷新**，别指望它看视频。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', description: '"start" | "stop" | "status"（默认 status）' },
      quality: { type: 'integer', description: 'start 时的 MJPEG 质量 2-31，默认 5（越小越好）。' },
    },
    output: out('解码器状态、流宽高、帧数、实测 fps。'),
  };
}

export function liveShotSpec() {
  return {
    name: 'vdisplay_live_shot',
    description: [
      '从视频流里取一张最新帧（比 vdisplay_shot 快得多）。',
      '',
      '前提两条：① 先 vdisplay_live action=start；② 画面要动（静止屏收不到帧）。',
      '满足不了就回退到 vdisplay_shot。',
      '',
      '实测：常驻解码后读一帧 <1ms，按需解码约 244ms，screencap 约 143ms。',
    ].join('\n'),
    parameters: {
      width: { type: 'integer', description: '缩放宽度，0=原生 720。默认 0。' },
      dir: { type: 'string', description: '输出目录，默认 /tmp。' },
    },
    output: out('图片路径、宽高、来源（persistent-decoder / on-demand）、帧龄、实测 fps。'),
  };
}

export function waitStableSpec() {
  return {
    name: 'vdisplay_wait_stable',
    description: [
      '等画面稳定下来再继续（替代固定 sleep）。',
      '',
      '用 32×32 灰度信号判断：连续 stableMs 内变化量低于阈值才算稳。',
      '实测滑动后 121-182ms 就稳了，比固定 sleep(500) 快约 300ms，而且截图不会撞上转场中间态。',
      '',
      '典型用法：vdisplay_input 之后调它，再 vdisplay_shot。',
    ].join('\n'),
    parameters: {
      stableMs: { type: 'integer', description: '要连续稳多久才算稳，默认 120ms。' },
      maxWaitMs: { type: 'integer', description: '最多等多久，超了就用当前帧，默认 2500。' },
      threshold: { type: 'number', description: 'tailMad 低于它算稳，默认 0.5（滑动时 8-9，静止 0）。' },
    },
    output: out('等了多久、是否稳定、当前变化量。'),
  };
}

export function roiSpec() {
  return {
    name: 'vdisplay_roi',
    description: [
      '自动挑一块值得看的区域，拿去做局部放大。',
      '',
      '为什么有用：token 按 ⌈宽/42⌉×⌈高/42⌉ 计费，小于 544² 按地板价收。',
      '所以同样一笔 169 token，裁 420 见方是 1:1 像素，全屏缩到 420 宽只有 0.58x —— 清晰度差近 2 倍。',
      '',
      '区域怎么选：灰度变化包围盒 → 太大就用变化热力图挑最密集的 544² 子区 → 实在没有就用最近点击位置兜底。',
      '',
      '返回的 region 直接传给 vdisplay_shot 的 region 参数。',
    ].join('\n'),
    parameters: {
      outputWidth: { type: 'integer', description: '打算输出的宽度，默认 544。注意 544 以下都是地板价 169，所以 544 比 420 同价多看 68% 面积。' },
      minArea: { type: 'number', description: '区域至少占整屏多少，默认 0.04。太小没信息量。' },
    },
    output: out('region（x/y/w/h）、来源（sensor-bbox / sensor-bbox+hotspot / last-input）、占屏面积。'),
  };
}

export function probeSecureSpec() {
  return {
    name: 'vdisplay_probe_secure',
    description: [
      '黑屏探针：判断这块屏上的内容是不是抓不到（FLAG_SECURE）。',
      '',
      'FLAG_SECURE 是 Android 对受保护内容的保护：任何截屏 API 拿到的都是纯黑，',
      'screencap / 视频流 / MediaProjection 全一样。**这是无 root 的硬边界，绕不过去。**',
      '',
      '判定：',
      '  A  正常出画',
      '  B? 疑似受保护（上半黑、下半可读）—— 会再用 dumpsys 的 FLAG_SECURE 窗口数复核',
      '  C  整屏黑 —— App 拒绝在虚拟屏渲染，或者没起来',
      '  A? 原本疑似但复核为不是受保护（通常是底部弹窗造成的误报）',
      '',
      '投屏之后建议先跑一次，能提前知道这条线能不能做。',
    ].join('\n'),
    parameters: {
      dir: { type: 'string', description: '截图输出目录，默认 /tmp。' },
    },
    output: out('verdict、置信度、判定理由、上下半亮度、dumpsys 里的 FLAG_SECURE 窗口数。'),
  };
}

/**
 * 查用户是否正在用手机。
 *
 * 这是把 `tools/user-busy.sh` 的判据变成工具 —— 那个脚本是对的，但不在工具链路里，
 * 所以模型不知道要调它。2026-11-17 抢键盘事故就是没查这个。
 */
export function userStateSpec() {
  return {
    name: 'screen_user_state',
    description: [
      '查「用户现在在用手机吗」。**动主屏之前必须先调它。**',
      '',
      '判据：前台是 DSH Go（用户正在跟 AI 对话）或输入法正在显示（用户可能在打字）→ BUSY。',
      '',
      '为什么要有：`am start` / `mcp__phone__open` 会让新窗口成为焦点，',
      '输入法的 InputConnection 从用户的输入框 detach —— 键盘被抢走、半截草稿丢失。',
      '更危险的是 `input text` 会把文字拼进用户草稿，`input keyevent 66` 可能把草稿发出去。',
      '',
      '返回 BUSY 时改走：虚拟屏（vdisplay_*）、浏览器 CDP（web_*），或等用户停下来。',
    ].join('\n'),
    parameters: {},
    output: out('BUSY/IDLE 判定、前台包名、输入法状态。'),
  };
}

/** 查某个 App 的风控等级（读 docs/risk.json，42 个 App 已标注）。 */
export function riskCheckSpec() {
  return {
    name: 'screen_risk',
    description: [
      '查某个 App 的风控等级，决定能用什么操作方式。',
      '',
      'L0 无风控 → 随便操作；L1 控制频率；L2 拟人化；',
      'L3 严格 → 只读，写操作必须问用户；L4 银行/支付 → 只能交给人；L5 技术做不到。',
      '',
      '**操作微信/支付宝/银行/游戏之前先查这个。** 未知 App 按 L3 处理。',
    ].join('\n'),
    parameters: {
      pkg: { type: 'string', required: true, description: '包名，比如 com.tencent.mm。不知道包名先用 vdisplay_apps 查。' },
    },
    output: out('风控等级、中文名、禁止动作列表。'),
  };
}

/**
 * 按文字找位置。
 *
 * 现在模型是「看 OCR 返回的一堆 nx/ny，自己挑坐标去点」—— 实测 17.6% 点空率。
 * 这两个工具把「找文字 → 算坐标」交给代码，模型不碰坐标。
 */
export function findTextSpec() {
  return {
    name: 'vdisplay_find',
    description: [
      '在虚拟屏上找文字，返回坐标（不点击）。',
      '',
      '**比让模型自己看 OCR 坐标再算要准得多** —— 模型算坐标是 17.6% 点空率的主因。',
      '',
      '匹配规则：默认「包含」（找「蓝牙」→ 「蓝牙 已开启」也算命中）；',
      'mode=exact 精确匹配；mode=regex 正则。多个命中时默认取最靠上的，用 nth 指定第几个。',
      '',
      '没找到会给「相近的文字」建议，方便你换词重试。',
      '',
      '要直接点，用 vdisplay_tap_text —— 它一步完成找+点。',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: '要找的文字，比如「蓝牙」「立即购买」' },
      mode: { type: 'string', description: 'contains（默认）| exact | regex' },
      nth: { type: 'integer', description: '多个命中时取第几个，从 0 开始，默认 0（最靠上的）' },
      minConf: { type: 'number', description: 'OCR 置信度下限，默认 0.4' },
    },
    output: out('找到几处、目标坐标 nx/ny、命中文字。'),
  };
}

/** 找到文字并点击 —— 一步完成，模型不碰坐标。 */
export function tapTextSpec() {
  return {
    name: 'vdisplay_tap_text',
    description: [
      '找到文字并点击它。**这是最可靠的点击方式，优先用它代替自己算坐标。**',
      '',
      '一步完成：OCR 找文字 → 算中心坐标 → 注入点击 → 校验。',
      '模型只需要说要找什么，不需要看坐标。',
      '',
      '实测价值：现在模型自己看 OCR 坐标去点有 17.6% 点空率，这个工具把那个环节消掉。',
    ].join('\n'),
    parameters: {
      text: { type: 'string', required: true, description: '要点的文字，比如「立即购买」「确定」' },
      mode: { type: 'string', description: 'contains（默认）| exact | regex' },
      nth: { type: 'integer', description: '多个命中时点第几个，从 0 开始' },
      verify: { type: 'boolean', description: '点击后校验画面有没有变化，默认 true' },
    },
    output: out('点到了什么、坐标、校验结果。'),
  };
}

/** 调整后台屏的空闲超时 —— 让 AI 按任务预估生命周期。 */
export function keepAliveSpec() {
  return {
    name: 'screen_keepalive',
    description: [
      '设定「AI 停止操作多久后自动关掉后台屏」，让 AI 按任务预估生命周期。',
      '',
      '**开始长任务前先调它**：挂机、等转盘、轮询消息、玩需要时间累积的游戏 → 设大（30-360 分钟）；',
      '点几下就完的短任务 → 设小（2-5 分钟），省电更彻底。',
      '',
      '判据是「AI 连续 N 分钟没有调用任何工具」。**任何工具调用都会重置计时**，',
      '所以只要还在操作就不会被关；真闲着时才关。',
      '',
      '默认 5 分钟。范围 1~360 分钟。',
      '',
      '为什么需要它：实测后台屏不关时 framesrv 持续 10.3% CPU。',
      '设太短会在思考时被关掉，设太长会白白耗电 —— 按任务估是唯一正确的做法。',
    ].join('\n'),
    parameters: {
      minutes: { type: 'integer', required: true, description: '空闲多少分钟后自动关闭，1~360。短任务 2-5，长任务 30-360。' },
    },
    output: out('新的超时设定和含义。'),
  };
}
