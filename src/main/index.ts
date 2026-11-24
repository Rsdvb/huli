// Electron loads main's entry file through Node's ESM loader, which keeps a second copy of the
// file's text for as long as the app runs. So the entry holds only this, and the app is a chunk
// that require() loads, which keeps one copy.
void import('./app')
