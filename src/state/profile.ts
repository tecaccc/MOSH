/**
 * 个人资料状态（zustand）：名称 + 头像（settings key=`profile`）。
 *
 * App 启动时 load() 一次；设置页保存后全店同步（首页/今日问候即时生效）。
 * 未配置时 name=""（问候语不带称呼）、avatar=null（名称首字圆标兜底）。
 */

import { create } from "zustand";
import { getProfile, setProfile } from "../lib/ipc";

interface ProfileState {
  /** 展示名称；空 = 未配置（问候不带称呼）。 */
  name: string;
  /** 头像：图片 data URL / `emoji:表情` / null（首字圆标兜底）。 */
  avatar: string | null;
  /** 是否已从后端加载（区分“未配置”与“尚未加载”）。 */
  loaded: boolean;

  load(): Promise<void>;
  save(name: string, avatar: string | null): Promise<void>;
}

export const useProfileStore = create<ProfileState>()((set) => ({
  name: "",
  avatar: null,
  loaded: false,

  load: async () => {
    const p = await getProfile();
    if (p) {
      set({ name: p.name, avatar: p.avatar ?? null, loaded: true });
    } else {
      set({ name: "", avatar: null, loaded: true });
    }
  },

  save: async (name, avatar) => {
    await setProfile({ name, avatar });
    set({ name, avatar, loaded: true });
  },
}));
