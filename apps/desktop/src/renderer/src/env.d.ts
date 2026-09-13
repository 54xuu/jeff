/// <reference types="vite/client" />

/** Vite 会把音效当静态资源处理，import 得到打包后的 URL */
declare module '*.wav' {
  const src: string
  export default src
}
declare module '*.mp3' {
  const src: string
  export default src
}
