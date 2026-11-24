// Electron loads a utility process's entry file through Node's ESM loader, which keeps a second
// copy of the file's text and its bytes for as long as the process runs. So the entry holds only
// this, and the host is a chunk that require() loads, which keeps one copy.
void import('./index')
