/// <reference types="vite/client" />

/** 由 vite.config.js 的 `define` 编译期替换为 package.json 的 version。 */
declare const __APP_VERSION__: string;

/** CSS Modules（*.module.css）类型声明。 */
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
