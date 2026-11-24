/** 统一的线描图标：全部 24×24 网格、stroke=currentColor，
 *  尺寸由外层 CSS（.icon）控制，颜色跟随文字色，浅色/深色自动适配。
 */
import React from 'react';

type Props = { size?: number; className?: string };

function Svg({ size = 20, className, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconGear(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 13.6a7.7 7.7 0 0 0 0-3.2l1.7-1.3-1.9-3.3-2 .8a7.7 7.7 0 0 0-2.8-1.6L14 2.6h-4l-.4 2.4a7.7 7.7 0 0 0-2.8 1.6l-2-.8L2.9 9.1l1.7 1.3a7.7 7.7 0 0 0 0 3.2L2.9 14.9l1.9 3.3 2-.8a7.7 7.7 0 0 0 2.8 1.6l.4 2.4h4l.4-2.4a7.7 7.7 0 0 0 2.8-1.6l2 .8 1.9-3.3z" />
    </Svg>
  );
}

export function IconMenu(p: Props) {
  return (
    <Svg {...p}>
      <path d="M4 7h16M4 12h16M4 17h16" />
    </Svg>
  );
}

export function IconClose(p: Props) {
  return (
    <Svg {...p}>
      <path d="M6 6l12 12M18 6l-12 12" />
    </Svg>
  );
}

export function IconLock(p: Props) {
  return (
    <Svg {...p}>
      <rect x="4.6" y="10.4" width="14.8" height="9.6" rx="2.2" />
      <path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6" />
      <path d="M12 14.4v2" />
    </Svg>
  );
}

export function IconPaperclip(p: Props) {
  return (
    <Svg {...p}>
      <path d="M13.9 6.6 7.1 13.4a2.9 2.9 0 0 0 4.1 4.1l7.4-7.4a4.7 4.7 0 0 0-6.7-6.7L4.6 10.7a6.6 6.6 0 0 0 9.3 9.3l5.6-5.6" />
    </Svg>
  );
}

export function IconFile(p: Props) {
  return (
    <Svg {...p}>
      <path d="M13.4 3.4H7.2a2 2 0 0 0-2 2v13.2a2 2 0 0 0 2 2h9.6a2 2 0 0 0 2-2V9" />
      <path d="M13.4 3.4 19 9h-4.2a1.4 1.4 0 0 1-1.4-1.4z" />
    </Svg>
  );
}

export function IconSun(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.6v2.2M12 19.2v2.2M4.4 12H2.2M21.8 12h-2.2M6.1 6.1 4.6 4.6M19.4 19.4l-1.5-1.5M17.9 6.1l1.5-1.5M4.6 19.4l1.5-1.5" />
    </Svg>
  );
}

export function IconMoon(p: Props) {
  return (
    <Svg {...p}>
      <path d="M20 13.4A8.4 8.4 0 0 1 10.6 4a8.4 8.4 0 1 0 9.4 9.4z" />
    </Svg>
  );
}

export function IconMonitor(p: Props) {
  return (
    <Svg {...p}>
      <rect x="2.8" y="4" width="18.4" height="12" rx="2" />
      <path d="M9 20h6M12 16v4" />
    </Svg>
  );
}

export function IconUsers(p: Props) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="8.4" r="3.2" />
      <path d="M3.2 19.6a5.8 5.8 0 0 1 11.6 0" />
      <path d="M16.4 5.6a3.2 3.2 0 0 1 0 5.6M18 19.6a5.4 5.4 0 0 0-1.6-3.8" />
    </Svg>
  );
}

/** 品牌标记：锁 + 折角，替代原来的 ◆ 字符 */
export function IconBrand(p: Props) {
  return (
    <Svg {...p}>
      <path d="M12 2.8 3.8 7.2v5.2c0 4.6 3.4 7.7 8.2 8.8 4.8-1.1 8.2-4.2 8.2-8.8V7.2z" />
      <path d="M9.2 12.2h5.6v4H9.2zM10.8 12.2v-1.5a1.6 1.6 0 0 1 3.2 0v1.5" />
    </Svg>
  );
}
