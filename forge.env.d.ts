/// <reference types="@electron-forge/plugin-vite/forge-vite-env" />

declare module '*.svg' {
  const src: string;
  export default src;
}
declare module '*.png' {
  const src: string;
  export default src;
}
