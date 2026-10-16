// Lightweight UI internationalisation for the Vela chrome.
//
// Vela's DOM chrome (topbar, menus, drawers, dialogs, status line, panels) renders
// English literals. Rather than thread a `t()` call through every component, this
// module keeps an English→translation dictionary and translates the rendered DOM in
// place (text nodes + a few attributes), re-running on mutations so dynamically
// created menus/dialogs are covered too. Canvas-drawn text (axis ticks, plotted
// indicator titles) is out of scope — it never appears as DOM.

export type Locale = 'en' | 'zh-CN';

/** English source string → Simplified Chinese. Keys must match the rendered text. */
const ZH_CN: Record<string, string> = {
    // Topbar / bottom bar
    Indicators: '指标',
    'Chart settings': '图表设置',
    'Chart style': '图表样式',
    'Chart type': '图表类型',
    Timeframe: '周期',
    Timeframes: '周期',
    'Time zone': '时区',
    Symbol: '品种',
    'Symbol Search': '品种搜索',
    'Symbol search': '搜索品种',
    'Symbol name': '品种名称',
    'Symbol logo': '品种图标',
    'Symbol watermark': '品种水印',
    'Replay watermark': '回放水印',
    Layout: '布局',
    Alerts: '警报',
    'No alerts yet': '暂无警报',
    'No alerts yet.': '暂无警报。',
    Replay: '回放',
    'Replay Mode': '回放模式',
    Screenshot: '截图',
    'Download screenshot': '下载截图',
    'Download a screenshot of the layout': '下载布局截图',
    'Keyboard shortcuts': '快捷键',
    'Data window': '数据窗口',
    'Object tree': '对象树',
    Drawings: '绘图',
    'Market status': '市场状态',
    'Market Open': '开盘中',
    'Market Closed': '已收盘',
    'Market Holiday': '休市',
    Volume: '成交量',

    // Timeframe / symbol quick entries
    'Change timeframe': '切换周期',
    'Search…': '搜索…',
    'Search symbol…': '搜索品种…',
    'Search tools…': '搜索工具…',
    'Not a timeframe': '不是有效周期',

    // Menus
    'Settings…': '设置…',
    'More settings…': '更多设置…',
    General: '通用',
    'Scales and lines': '刻度与线',
    Advanced: '高级',
    Style: '样式',
    Labels: '标签',
    Levels: '水平线',
    Crosshair: '十字线',
    'Status line': '状态栏',
    'Price scale': '价格坐标',
    'Price axis labels': '价格轴标签',
    'Last price label': '最新价标签',
    'Last Price Line': '最新价线',
    'Countdown to bar close': '收盘倒计时',
    'Auto (fits data to screen)': '自动（适应数据）',
    'Invert scale': '反转坐标',
    'Toggle logarithmic scale': '切换对数坐标',
    'Toggle percent scale': '切换百分比坐标',
    'Reset chart view': '重置图表视图',
    'Reset view (all history)': '重置视图（全部历史）',
    'Reset view': '重置视图',
    'Reset chart': '重置图表',
    Logarithmic: '对数',
    Percent: '百分比',
    'Indexed to 100': '归一化到 100',
    Watermark: '水印',
    Titles: '标题',
    Values: '数值',
    Session: '交易时段',
    'Trading session': '交易时段',
    'Extended hours': '盘前盘后',
    'Extended Hours': '盘前盘后',
    'Extended hours (ETH)': '盘前盘后 (ETH)',
    Regular: '常规',
    'Regular hours (RTH)': '常规时段 (RTH)',
    'Pre-market': '盘前',
    'Post-market': '盘后',
    'Pre-Market': '盘前',
    'Post-Market': '盘后',

    // Remove / edit actions
    Remove: '删除',
    'Remove all': '全部删除',
    'Remove drawings': '删除绘图',
    'Remove indicators': '删除指标',
    'Remove from chart': '从图表移除',
    'Remove from favorites': '取消收藏',
    'Add to favorites': '加为收藏',
    Duplicate: '复制',
    'Select all': '全选',
    'Group the selected drawings': '组合选中的绘图',
    'Duplicate the selected drawings': '复制选中的绘图',
    Ungroup: '取消组合',
    'Bring to front': '置于顶层',
    'Send to back': '置于底层',
    'Bring all to front': '全部置于顶层',
    'Send all to back': '全部置于底层',
    'Lock all': '全部锁定',
    'Unlock all': '全部解锁',
    Unlock: '解锁',
    'Hide all': '全部隐藏',
    'Show all': '全部显示',
    'Move to': '移动到',
    'Move to group': '移动到分组',
    'Add to group': '添加到分组',
    'New group': '新建分组',
    'Already in a group': '已在分组中',
    'Rename…': '重命名…',
    Restore: '恢复',
    'Restore layout': '恢复布局',
    'Restore panes': '恢复面板',
    Maximize: '最大化',
    'Maximize chart': '最大化图表',
    'Maximize pane': '最大化面板',
    'Collapse pane': '折叠面板',
    'Expand pane': '展开面板',
    'Move pane up': '上移面板',
    'Move pane down': '下移面板',
    'New pane above': '上方新建面板',
    'New pane below': '下方新建面板',
    'Pin beside the chart': '固定在图表旁',
    'Unpin — float over the chart': '取消固定 — 浮于图表上',
    'Drag to change what draws in front': '拖动调整层级',
    'Drag to move chart': '拖动以移动图表',
    'Draws against its own price scale': '使用独立价格坐标',
    'Main chart': '主图',
    'Hide chart': '隐藏图表',
    'Show chart': '显示图表',
    'Move to …': '移动到…',

    // Price styles
    Candles: 'K线',
    Bars: '美国线',
    Line: '线形',
    Area: '面积',
    Baseline: '基线',
    'Heikin Ashi': '平均K线',
    Hollow: '空心K线',

    // Panels / drawers
    'Indicator settings': '指标设置',
    'Built-in': '内置',
    Canvas: '画布',
    'OHLC values': 'OHLC 数值',
    'Bar change values': '柱体涨跌值',
    Interval: '间隔',
    'Bars to fetch': '获取根数',

    // Tools
    Eraser: '橡皮擦',
    'Magnet snap': '吸附',
    'Stay in drawing mode': '保持绘图模式',
    'Exit drawing mode': '退出绘图模式',
    'Arm the trend line tool': '启用趋势线工具',
    'Delete the drawing under the cursor': '删除光标下的绘图',
    'Measure from the press point': '从按下点测量',
    'Pan toward history': '向历史平移',
    'Pan toward now': '向当前平移',
    'Scroll through history': '滚动历史',
    'Zoom in': '放大',
    'Zoom out': '缩小',
    'Horizontal line at the cursor price': '光标价格处的水平线',
    'Vertical line at the cursor time': '光标时间处的垂直线',

    // Undo/redo
    'Undo (active chart)': '撤销（当前图表）',
    'Redo (active chart)': '重做（当前图表）',

    // Symbol categories
    Stocks: '股票',
    Crypto: '加密货币',
    Futures: '期货',
    Commodities: '大宗商品',
    Index: '指数',

    // Empty states
    'No data': '无数据',
    'No symbols match.': '无匹配品种。',
    'No tools match.': '无匹配工具。',
    'No indicators match.': '无匹配指标。',
    'No indicators in the manifest.': '清单中没有指标。',
    'No symbols indexed (provider still loading?).': '未索引品种（数据源仍在加载？）。',
    'This renderer provides no data readout.': '此渲染器不提供数据读数。',
    'VelaWorkspace has no active cell yet': '工作区尚无活动单元',
    'VelaWorkspace has no active cell (destroyed?)': '工作区无活动单元（已销毁？）',

    // Date picker
    January: '一月',
    February: '二月',
    March: '三月',
    April: '四月',
    May: '五月',
    June: '六月',
    July: '七月',
    August: '八月',
    September: '九月',
    October: '十月',
    November: '十一月',
    December: '十二月',
    'Choose month': '选择月份',
    'Choose year': '选择年份',
    'Previous month': '上个月',
    'Next month': '下个月',
    'Previous year': '上一年',
    'Next year': '下一年',
    'Previous decade': '上一个十年',
    'Next decade': '下一个十年',
    Date: '日期',
    Time: '时间',
    'Date Range': '日期范围',

    // Settings dialog sections & fields
    Type: '类型',
    Body: '实体',
    Borders: '边框',
    Wick: '影线',
    Spacing: '间距',
    OPACITY: '不透明度',
    'BACKGROUND & TEXT': '背景与文字',
    Background: '背景',
    'Text color': '文字颜色',
    'Text size': '文字大小',
    'Pane separator color': '面板分隔线颜色',
    GRID: '网格',
    Vertical: '垂直线',
    Horizontal: '水平线',
    MARGINS: '边距',
    Top: '上',
    Bottom: '下',
    Left: '左',
    Right: '右',
    bars: '根',
    THEME: '主题',
    'Color theme': '颜色主题',
    Dark: '深色',
    Light: '浅色',
    'Reset defaults': '恢复默认',
    Mode: '模式',
    'Axis labels': '坐标轴标签',
    'Scale border color': '刻度边框颜色',
    Color: '颜色',
    Width: '宽度',
    Dashed: '虚线',
    Solid: '实线',
    Dotted: '点线',
    ANIMATION: '动画',
    'Animate zoom': '缩放动画',
    'Pan momentum': '平移惯性',
    'Animate price scale': '价格坐标动画',
    'Animate price changes': '价格变化动画',
    'Reveal on load': '加载时渐显',
    Opacity: '不透明度',
    'Opacity (%)': '不透明度 (%)',
    Increase: '增加',
    Decrease: '减少',

    // Symbol categories
    All: '全部',
    ETFs: 'ETF',
    Forex: '外汇',
    Indices: '指数',
    'Background & text': '背景与文字',
    Grid: '网格',
    Margins: '边距',
    Theme: '主题',
    Animation: '动画',
    'Visible events': '显示事件',
    Events: '事件',
    'Show contracts': '显示合约',

    // Drawing toolbar groups + tooltips
    Cursor: '光标',
    Lines: '线条',
    Fibonacci: '斐波那契',
    Shapes: '形状',
    Patterns: '形态',
    Text: '文字',
    Icons: '图标',
    Measure: '测量',
    Measurements: '测量',
    'Collapse toolbar': '收起工具栏',
    'Eraser (click/drag to delete)': '橡皮擦（点击/拖动删除）',
    'Sync drawings on all charts': '在所有图表间同步绘图',
    Undo: '撤销',
    Redo: '重做',

    // Bottom-bar range presets
    ALL: '全部',
    YTD: '今年',

    // Panels / dialogs
    Close: '关闭',
    Hide: '隐藏',

    // Drawing tools & their settings (left toolbar flyouts + popups)
    'ABCD Pattern': 'ABCD 形态',
    'Account balance': '账户余额',
    Always: '始终',
    Anchor: '锚点',
    'Anchored VWAP': '锚定 VWAP',
    Arc: '弧线',
    Arrow: '箭头',
    'Arrow Mark Down': '向下箭头标记',
    'Arrow Mark Up': '向上箭头标记',
    Arrows: '箭头',
    Auto: '自动',
    'Band fill': '通道填充',
    'Band multiplier': '通道倍数',
    Bat: '蝙蝠形态',
    Bearish: '看跌',
    Bold: '粗体',
    Breaker: '突破块',
    Brush: '画笔',
    Brushes: '画笔',
    Bullish: '看涨',
    Butterfly: '蝴蝶形态',
    Callout: '标注',
    Channels: '通道',
    Circle: '圆',
    Classic: '经典',
    Comment: '注释',
    Crab: '螃蟹形态',
    'Cross Line': '十字线',
    Curve: '曲线',
    Cypher: '赛福形态',
    'Date & Price Range': '日期与价格范围',
    'Dedekind Tessellation': '戴德金镶嵌',
    'Developing POC': '动态 POC',
    'Developing POC color': '动态 POC 颜色',
    'Developing POC style': '动态 POC 样式',
    'Developing VA': '动态价值区',
    'Developing VA color': '动态价值区颜色',
    'Developing VA style': '动态价值区样式',
    Direction: '方向',
    'Disjoint Channel': '非平行通道',
    'Down Volume': '下跌成交量',
    'Down candles': '下跌K线',
    'Elliott Correction Wave (ABC)': '艾略特调整浪 (ABC)',
    'Elliott Impulse Wave (1-5)': '艾略特推动浪 (1-5)',
    'Elliott Waves': '艾略特波浪',
    Ellipse: '椭圆',
    'Entry price': '入场价',
    'Extend both ways': '双向延伸',
    'Extend left': '向左延伸',
    'Extend right': '向右延伸',
    'Extended Line': '延长线',
    Extension: '扩展',
    'Fade at end': '末端淡出',
    'Fair Value Gap': '公允价值缺口',
    'Fib Channel': '斐波那契通道',
    'Fib Circles': '斐波那契圆',
    'Fib Extension': '斐波那契扩展',
    'Fib Fan': '斐波那契扇形',
    'Fib Retracement': '斐波那契回撤',
    'Fib Speed Resistance Arcs': '斐波那契速度阻力弧',
    'Fib Speed Resistance Fan': '斐波那契速度阻力扇',
    'Fib Spiral': '斐波那契螺旋',
    'Fib Time Zones': '斐波那契时间区',
    'Fib Wedge': '斐波那契楔形',
    'Fill color': '填充颜色',
    'Fixed Range Volume Profile': '固定区间成交量分布',
    Flag: '旗形',
    'Flat Top/Bottom': '平顶/平底',
    'Flip on close': '收盘翻转',
    'Full range': '全区间',
    Gann: '江恩',
    'Gann Box': '江恩箱',
    'Gann Fan': '江恩扇',
    'Gann Square': '江恩方形',
    Gartley: '加特利形态',
    Geometry: '几何',
    'Golden Sonic': '黄金 Sonic',
    'Golden Supersonic': '黄金超音速',
    Harmonics: '谐波',
    'Head & Shoulders': '头肩形',
    'Head (end)': '头（结束）',
    'Head (start)': '头（开始）',
    Highlighter: '荧光笔',
    'Horizontal Line': '水平线',
    'Horizontal Ray': '水平射线',
    Huge: '超大',
    Icon: '图标',
    'Info Line': '信息线',
    'Inside Pitchfork': '内侧叉形线',
    Italic: '斜体',
    Large: '大',
    'Line color': '线条颜色',
    'Line style': '线条样式',
    'Line width': '线宽',
    'Linear Regression': '线性回归',
    Liquidity: '流动性',
    Long: '多头',
    'Long/Short Position': '多/空头头寸',
    'Loss zone': '亏损区',
    'Lower band color': '下轨颜色',
    'Lower fill': '下部填充',
    'Lower line color': '下轨线颜色',
    'Lower line style': '下轨线样式',
    'Mach number': '马赫数',
    Magnifier: '放大镜',
    'Mark sweep': '标记扫单',
    'Max curvature': '最大曲率',
    Midline: '中线',
    'Midline color': '中线颜色',
    'Midline style': '中线样式',
    'Modified Schiff Pitchfork': '修正希夫叉形线',
    Note: '便签',
    OTE: 'OTE',
    'Order Block': '订单块',
    'POC color': 'POC 颜色',
    'POC style': 'POC 样式',
    'Parallel Channel': '平行通道',
    Path: '路径',
    Pitchfork: '叉形线',
    Pitchforks: '叉形线',
    Points: '点数',
    Polyline: '折线',
    'Position size': '仓位大小',
    Price: '价格',
    'Price Action': '价格行为',
    'Price Label': '价格标签',
    'Price Note': '价格便签',
    'Profit zone': '盈利区',
    Ray: '射线',
    Rectangle: '矩形',
    'Reset settings': '重置设置',
    'Risk %': '风险 %',
    'Rotated Rectangle': '旋转矩形',
    Rows: '行数',
    'Schiff Pitchfork': '希夫叉形线',
    Sec: '秒',
    Shark: '鲨鱼形态',
    Short: '空头',
    'Show R²': '显示 R²',
    'Show date': '显示日期',
    'Show direction & ratio': '显示方向与比例',
    'Show level prices': '显示各档价格',
    'Show loss & size': '显示止损与仓位',
    'Show price': '显示价格',
    'Show ratios': '显示比例',
    'Show stop label': '显示止损标签',
    'Show target label': '显示目标标签',
    'Show text': '显示文字',
    Signpost: '路标',
    Size: '大小',
    Small: '小',
    'Stop price': '止损价',
    'Target price': '目标价',
    'Trend Angle': '趋势角度',
    'Trend Line': '趋势线',
    'Trend-Based Fib Extension': '趋势斐波那契扩展',
    'Trend-Based Fib Time': '趋势斐波那契时间',
    Triangle: '三角形',
    'Until 50%': '直到 50%',
    'Until broken': '直到突破',
    'Until filled': '直到成交',
    'Until swept': '直到被扫',
    'Until tested': '直到测试',
    'Up Volume': '上涨成交量',
    'Up candles': '上涨K线',
    'Upper band color': '上轨颜色',
    'Upper fill': '上部填充',
    'Upper line color': '上轨线颜色',
    'Upper line style': '上轨线样式',
    'VAH color': 'VAH 颜色',
    'VAH style': 'VAH 样式',
    'VAL color': 'VAL 颜色',
    'VAL style': 'VAL 样式',
    'VWAP color': 'VWAP 颜色',
    'VWAP style': 'VWAP 样式',
    'Value Area': '价值区',
    'Value Area Down': '价值区下沿',
    'Value Area Up': '价值区上沿',
    'Vertical Line': '垂直线',
    Waves: '波浪',
    'Width %': '宽度 %',
    'XABCD Pattern': 'XABCD 形态',
    Zone: '区域',
    Normal: '常规',

    // OHLC readouts (data window). 'Close' is resolved by context in translateText
    // because the same word labels the panel close button (关闭).
    Open: '开盘',
    High: '最高',
    Low: '最低',

    // Magnet flyout + misc tool names
    Magnet: '吸附',
    Off: '关',
    On: '开',
    Weak: '弱',
    Strong: '强',
    Supersonic: '超音速',

    // Indicator library
    'Search indicators…': '搜索指标…',
    Chart: '图表',
    Library: '指标库',
    Families: '分类',
    'On chart': '已在图表',
    'Select an indicator': '选择一个指标',
    'Add to chart': '加入图表',
    'Nothing on the chart yet.': '图表上暂无指标。',
    'New script': '新建脚本',
    Edit: '编辑',
    Delete: '删除',
};

// Case-insensitive index into the dictionary — a fallback for code/CSS-uppercased
// section headers whose exact casing differs ('PRICE ACTION' -> 'Price Action').
const LOWER = new Map<string, string>();
for (const [en, zh] of Object.entries(ZH_CN)) {
    const lower = en.toLowerCase();
    if (!LOWER.has(lower)) LOWER.set(lower, zh);
}

let current: Locale = 'en';
let installed = false;

export function getLocale(): Locale {
    return current;
}

/** Translate one English source string. Unknown strings fall through unchanged. */
export function t(en: string): string {
    if (current === 'en') return en;
    return ZH_CN[en] ?? en;
}

const ATTRS = ['title', 'aria-label', 'placeholder'] as const;

function lookup(key: string): string | undefined {
    const exact = ZH_CN[key];
    if (exact != null) return exact;
    // Section headers are often rendered uppercase (in code or via CSS). Retry with the
    // key title-cased, then case-insensitively, so 'PRICE ACTION' still resolves.
    if (key === key.toUpperCase() && /[A-Z]/.test(key)) {
        const title = key.charAt(0) + key.slice(1).toLowerCase();
        return ZH_CN[title] ?? LOWER.get(key.toLowerCase());
    }
    return undefined;
}

function translateText(node: Text): void {
    const raw = node.nodeValue;
    if (!raw) return;
    const key = raw.trim();
    let zh = lookup(key);
    // Same word, two meanings: the data window's close-price row vs the panel's close
    // button. Resolve the row by where it lives (the data-window root class).
    if (key === 'Close' && node.parentElement?.closest('.vela-dw')) zh = '收盘';
    if (zh == null) return;
    node.nodeValue = raw.replace(key, zh);
}

function translateAttrs(el: Element): void {
    for (const attr of ATTRS) {
        const value = el.getAttribute(attr);
        if (!value) continue;
        const zh = lookup(value.trim());
        if (zh != null) el.setAttribute(attr, zh);
    }
}

function translateNode(node: Node): void {
    if (node.nodeType === Node.TEXT_NODE) {
        translateText(node as Text);
        return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    translateAttrs(el);
    for (const child of el.childNodes) translateNode(child);
}

function startObserver(): void {
    if (installed || typeof document === 'undefined' || !document.body) return;
    installed = true;
    const observer = new MutationObserver((records) => {
        if (current === 'en') return;
        for (const record of records) {
            if (record.type === 'childList') {
                for (const node of record.addedNodes) translateNode(node);
            } else if (record.type === 'characterData') {
                translateText(record.target as Text);
            } else if (record.type === 'attributes') {
                translateAttrs(record.target as Element);
            }
        }
    });
    observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...ATTRS],
    });
}

/**
 * Set the UI locale and translate the rendered chrome. Idempotent — switching back
 * to `'en'` stops translating new nodes (already-translated text stays until the
 * component re-renders). Call it once at startup, ideally right after the chart or
 * workspace is created.
 */
export function setLocale(locale: Locale, root?: ParentNode): void {
    current = locale;
    if (locale === 'en') return;
    if (typeof document === 'undefined') return;
    startObserver();
    translateNode((root ?? document.body) as Node);
}
