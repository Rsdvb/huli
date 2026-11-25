// Folders Kettu keeps for the user, outside its own data folder: they survive uninstalling the
// app, and hold things the harnesses and agents own.

// Huli keeps its own folder, so it never shares harness installs or plugins with an installed Kettu.
export const KETTU_HOME_FOLDER = '.huli'
export const AGENTS_FOLDER = 'agents'
export const HARNESSES_FOLDER = 'harnesses'
