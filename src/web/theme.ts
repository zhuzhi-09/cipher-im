/** 主题：跟随系统 / 强制浅色 / 强制深色
 *  真实生效的主题始终写在 <html data-theme="light|dark"> 上，
 *  这样 CSS 只需要两套变量，不用在媒体查询里复制一遍。
 */
export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'cipherim.theme';
const META_LIGHT = '#F7F7F8';
const META_DARK = '#0E0E10';

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    /* 隐私模式读不到，按系统走 */
  }
  return 'system';
}

function systemDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function resolveTheme(pref: ThemePref): 'light' | 'dark' {
  if (pref === 'system') return systemDark() ? 'dark' : 'light';
  return pref;
}

export function applyTheme(pref: ThemePref): 'light' | 'dark' {
  const mode = resolveTheme(pref);
  document.documentElement.dataset.theme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? META_DARK : META_LIGHT);
  return mode;
}

export function setThemePref(pref: ThemePref): 'light' | 'dark' {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* 存不下也不影响本次生效 */
  }
  return applyTheme(pref);
}

/** 系统配色变化时回调（只在“跟随系统”下有意义），返回值取消监听 */
export function onSystemThemeChange(cb: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = () => cb();
  mql.addEventListener('change', handler);
  return () => mql.removeEventListener('change', handler);
}
