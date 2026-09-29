// The reader's DOM shell, built in JS rather than living in an HTML file.
//
// The dev page and the exported page must present exactly the same DOM: the exporter's
// frames are compared against the reader, and a stray wrapper element would shift the
// layout and change camera.aspect. Keeping one copy here is what guarantees that.
export const SHELL = `
<main>
  <div id="scene" role="region" aria-label="故事书，可点击或拖动翻页"></div>
  <button id="prev" class="page-arrow previous" aria-label="上一页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14 6-6 6 6 6"/></svg></button>
  <button id="next" class="page-arrow next" aria-label="下一页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 6 6 6-6 6"/></svg></button>
  <span id="chapter" class="sr-only" aria-live="polite">封面</span>
</main>
<p id="media-status" class="media-status" role="status" hidden></p>
<p id="ai-disclosure" class="ai-disclosure" hidden>AI 配音</p>
<p id="export-disclosure" hidden></p>
<footer>
  <button id="reset" class="round-button" aria-label="回到封面" title="回到封面"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10 12 3l8 7v10h-6v-6h-4v6H4Z"/></svg></button>
  <nav id="pagination" aria-label="书本章节"></nav>
  <button id="play" class="round-button play-button" aria-label="自动翻页" aria-pressed="false" title="自动翻页"><svg class="play-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="m9 5 11 7-11 7Z"/></svg><svg class="pause-symbol" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6v12M16 6v12"/></svg></button>
</footer>
`;

// Replace whatever is in the mount point with a fresh shell.
export function buildShell(root) {
  root.innerHTML = SHELL;
  return root;
}
