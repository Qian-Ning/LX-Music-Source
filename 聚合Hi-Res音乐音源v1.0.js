/*!
 * @name 聚合Hi-Res音乐音源v1.0
 * @description 整合长青/W/星海音源，支持网易云/QQ/酷狗/酷我/咪咕 Hi-Res 24bit
 * @version v1.0
 * @updateUrl https://zrcdy.dpdns.org/lx/xinghai-music-source.js
 * @support 网易云/QQ/酷狗/酷我/咪咕（24bit/FLAC/320k等全音质）
 */
// ============================ 核心配置（整合多源）============================
const CONFIG = {
  // 版本更新配置
  update: {
    versionApiUrl: 'https://zrcdy.dpdns.org/lx/version.php',
    latestScriptUrl: 'https://zrcdy.dpdns.org/lx/xinghai-music-source.js',
    currentVersion: 'v1.0'
  },
  // 核心解析API（聚合多源接口）
  api: {
    main: 'https://music-api.gdstudio.xyz/api.php?use_xbridge3=true&loader_name=forest&need_sec_link=1&sec_link_scene=im&theme=light',
    backup: 'https://13413.kstore.vip/lxmusic/changqing.json'
  },
  // 频率限制（防请求超限）
  rateLimit: {
    maxRequests: 60,
    timeWindow: 5 * 60 * 1000 // 60次/5分钟
  },
  // 音质支持配置（Hi-Res 24bit优先）
  quality: {
    wy: ['flac24bit', 'flac', '320k', '192k', '128k'], // 网易云
    tx: ['flac24bit', 'flac', '320k', '192k', '128k'], // QQ音乐
    kg: ['flac24bit', 'flac', '320k', '192k', '128k'], // 酷狗
    kw: ['flac24bit', 'flac', '320k', '192k', '128k'], // 酷我
    mg: ['flac', '320k', '192k', '128k'] // 咪咕（原生无24bit）
  },
  // 平台映射（对接解析API）
  sourceMap: { wy: 'netease', tx: 'tencent', kg: 'kugou', kw: 'kuwo', mg: 'migu' },
  // 音质码映射（对接API参数）
  qualityMap: { '128k': '128', '192k': '192', '320k': '320', 'flac': '740', 'flac24bit': '999' }
};

// 全局对象获取（适配LX Music系列播放器）
const { EVENT_NAMES, request, on, send } = globalThis.lx || globalThis['lx'];
const MUSIC_PLATFORMS = Object.keys(CONFIG.quality);

// ============================ 工具函数（通用/稳定）============================
/**
 * 日志简化输出
 */
const log = (action, source, msg, status = 'info') => {
  console.log(`[聚合音源-${action}] [${source}] [${status}] ${msg}`);
};

/**
 * 音质自动适配/降级（24bit不可用则降级到FLAC，依次类推）
 */
const mapQuality = (target, source) => {
  const available = CONFIG.quality[source];
  if (available.includes(target)) return target;
  // 按优先级匹配（从高到低）
  const priority = [...available];
  for (const q of priority) {
    if (available.includes(q)) return q;
  }
  return '128k'; // 保底音质
};

/**
 * 请求频率限制器（防止接口封禁）
 */
class RateLimiter {
  constructor() {
    this.requests = [];
  }
  check() {
    const now = Date.now();
    this.requests = this.requests.filter(t => now - t < CONFIG.rateLimit.timeWindow);
    const allowed = this.requests.length < CONFIG.rateLimit.maxRequests;
    allowed && this.requests.push(now);
    return {
      allowed,
      resetIn: Math.ceil((Math.min(...this.requests) + CONFIG.rateLimit.timeWindow - now) / 60000) || 5
    };
  }
}
const rateLimiter = new RateLimiter();

/**
 * 封装HTTP请求（适配播放器request API，带错误处理）
 */
const httpRequest = (url, options = { method: 'GET' }) => {
  return new Promise((resolve, reject) => {
    const cancel = request(url, { timeout: 15000, ...options }, (err, resp) => {
      if (err) return reject(new Error(`网络错误：${err.message}`));
      let body = resp.body;
      // 自动解析JSON
      if (typeof body === 'string' && (body.startsWith('{') || body.startsWith('['))) {
        try { body = JSON.parse(body); } catch (e) {}
      }
      resolve({ body, status: resp.statusCode, headers: resp.headers || {} });
    });
  });
};

/**
 * 版本比对（检查更新）
 */
const compareVersions = (remote, current) => {
  const r = remote.replace(/^v/, '').split('.').map(Number);
  const c = current.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < Math.max(r.length, c.length); i++) {
    if ((r[i] || 0) > (c[i] || 0)) return true;
  }
  return false;
};

// ============================ 核心功能（多源整合）============================
/**
 * 检查版本更新（整合星海更新逻辑）
 */
const checkUpdate = async () => {
  try {
    const resp = await httpRequest(CONFIG.update.versionApiUrl);
    if (resp.status !== 200) throw new Error('更新接口无响应');
    const remoteVer = resp.body.version || resp.body.VERSION || '';
    if (!remoteVer) return;
    if (compareVersions(remoteVer, CONFIG.update.currentVersion)) {
      const logMsg = `发现新版本：${remoteVer}（当前：${CONFIG.update.currentVersion}）`;
      send(EVENT_NAMES.updateAlert, {
        log: `【聚合Hi-Res音源更新】\n${logMsg}\n更新地址：${CONFIG.update.latestScriptUrl}`,
        updateUrl: CONFIG.update.latestScriptUrl,
        confirmText: '立即更新',
        cancelText: '暂不更新'
      });
      log('update', 'system', logMsg, 'warn');
    }
  } catch (err) {
    log('update', 'system', `检查更新失败：${err.message}`, 'error');
  }
};

/**
 * 获取音乐播放地址（核心解析，整合长青/W/星海逻辑）
 * @param {string} source 平台（wy/tx/kg/kw/mg）
 * @param {object} musicInfo 歌曲信息（id/hash/songmid）
 * @param {string} targetQuality 目标音质
 */
const getMusicUrl = async (source, musicInfo, targetQuality) => {
  // 1. 频率限制检查
  const limit = rateLimiter.check();
  if (!limit.allowed) {
    throw new Error(`请求超限，请${limit.resetIn}分钟后重试（${CONFIG.rateLimit.maxRequests}次/5分钟）`);
  }

  // 2. 验证歌曲ID和平台
  const songId = musicInfo.hash ?? musicInfo.songmid ?? musicInfo.id ?? '';
  if (!songId || !MUSIC_PLATFORMS.includes(source)) {
    throw new Error('无效歌曲ID/不支持的平台');
  }

  // 3. 音质适配
  const actualQuality = mapQuality(targetQuality, source);
  const apiSource = CONFIG.sourceMap[source];
  const apiQuality = CONFIG.qualityMap[actualQuality];
  if (!apiSource || !apiQuality) {
    throw new Error(`平台${source}不支持${actualQuality}音质`);
  }
  log('resolve', source, `音质适配：${targetQuality} -> ${actualQuality}`, 'info');

  // 4. 拼接解析接口（主接口优先，失败自动切备用）
  const requestUrl = `${CONFIG.api.main}&types=url&source=${apiSource}&id=${songId}&br=${apiQuality}`;
  try {
    // 5. 发起请求并解析结果
    const resp = await httpRequest(requestUrl, {
      headers: { 'User-Agent': 'LX-Music-Mobile', 'Accept': 'application/json' }
    });
    if (!resp.body || !resp.body.url) {
      throw new Error(resp.body.msg || '接口无有效播放地址');
    }
    log('resolve', source, `解析成功（${actualQuality}）：${musicInfo.name || '未知歌曲'}`, 'success');
    return resp.body.url;
  } catch (err) {
    // 备用接口兜底（长青音源）
    log('resolve', source, `主接口失败：${err.message}，尝试备用接口`, 'warn');
    const backupResp = await httpRequest(CONFIG.api.backup);
    if (!backupResp.body) throw new Error('备用接口也失败，请稍后重试');
    return backupResp.body.url || '';
  }
};

// ============================ 播放器注册（核心入口）============================
/**
 * 注册音乐平台配置（供播放器识别）
 */
const registerSources = () => {
  const musicSources = {};
  MUSIC_PLATFORMS.forEach(source => {
    musicSources[source] = {
      name: { wy: '网易云音乐', tx: 'QQ音乐', kg: '酷狗音乐', kw: '酷我音乐', mg: '咪咕音乐' }[source],
      type: 'music',
      actions: ['musicUrl'],
      qualitys: CONFIG.quality[source]
    };
  });
  // 通知播放器初始化完成
  send(EVENT_NAMES.inited, {
    status: true,
    openDevTools: false,
    sources: musicSources
  });
  log('init', 'system', '多源聚合音源初始化完成，支持Hi-Res 24bit', 'success');
};

/**
 * 注册播放器事件监听（响应播放地址请求）
 */
const registerEvents = () => {
  on(EVENT_NAMES.request, async ({ action, source, info }) => {
    if (action !== 'musicUrl' || !info?.musicInfo || !info?.type) {
      return Promise.reject(new Error('无效请求参数'));
    }
    try {
      const url = await getMusicUrl(source, info.musicInfo, info.type);
      return Promise.resolve(url);
    } catch (err) {
      log('request', source, err.message, 'error');
      return Promise.reject(new Error(err.message));
    }
  });
};

// ============================ 初始化执行 =============================
(async () => {
  registerSources(); // 注册平台
  registerEvents();  // 注册事件
  setTimeout(checkUpdate, 2000); // 延迟检查更新，不阻塞初始化
})();