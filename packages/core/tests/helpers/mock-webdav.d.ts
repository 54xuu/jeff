declare module '*/mock-webdav.mjs' {
  export function startMockWebdav(port: number, rootDir: string): Promise<import('node:http').Server>
}
