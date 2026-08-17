/**
 * 用户头像：图片（data URL）/ emoji（`emoji:` 前缀）/ 名称首字符圆标兜底。
 * 首页 Banner、今日视图头部、设置页预览共用。
 */

import styles from "./Avatar.module.css";

interface AvatarProps {
  name: string;
  avatar?: string | null;
  /** 直径 px。 */
  size?: number;
}

export default function Avatar({ name, avatar, size = 40 }: AvatarProps) {
  if (avatar) {
    if (avatar.startsWith("emoji:")) {
      return (
        <span
          className={styles.emoji}
          style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}
          role="img"
          aria-label={name || "头像"}
        >
          {avatar.slice("emoji:".length)}
        </span>
      );
    }
    return (
      <img
        className={styles.img}
        style={{ width: size, height: size }}
        src={avatar}
        alt={name || "头像"}
      />
    );
  }
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span
      className={styles.initial}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
      aria-label={name || "头像"}
    >
      {initial}
    </span>
  );
}
