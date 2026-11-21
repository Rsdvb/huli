interface ImportMetaEnv {
  /** Set by the release workflow: `install` or `link`. */
  readonly MAIN_VITE_UPDATE_MODE?: string
}

// Vite's own queries, for the few files main bundles as text or data.
declare module '*?raw' {
  const text: string
  export default text
}

declare module '*?inline' {
  const data: string
  export default data
}
