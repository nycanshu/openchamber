import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CdpClient, createPageTarget, launchChrome, reservePort, resolveChrome, wait } from './cdp.mjs';

// Run against a disposable HMR app and a Markdown fixture, never the user's app.
const url = process.env.OPENCHAMBER_TEST_MARKDOWN_URL;
const file = process.env.OPENCHAMBER_TEST_MARKDOWN_FILE;
const directory = process.env.OPENCHAMBER_TEST_MARKDOWN_DIRECTORY;
const codeFile = process.env.OPENCHAMBER_TEST_CODE_FILE;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Markdown preview and Find keep their hit targets when switching modes', {
  skip: !(url && file && directory) && 'Set OPENCHAMBER_TEST_MARKDOWN_URL, _FILE and _DIRECTORY for an isolated HMR app',
  timeout: 240_000,
}, async () => {
  const fixtureContent = readFileSync(file, 'utf8');
  const profile = mkdtempSync(path.join(os.tmpdir(), 'oc-markdown-toolbar-'));
  let browser;
  let client;
  try {
    const port = await reservePort();
    browser = launchChrome({ chrome: resolveChrome(process.env.OPENCHAMBER_TEST_CHROME), port, profileDir: profile, headless: true });
    const target = await createPageTarget(port);
    client = new CdpClient(target.webSocketDebuggerUrl);
    await client.connect();
    const evaluate = async expression => {
      const response = await client.send('Runtime.evaluate', { expression: `globalThis.__toolbarEvaluation = (${expression})`, returnByValue: true, awaitPromise: true }).catch(error => {
        throw new Error(`Evaluation failed: ${expression}`, { cause: error });
      });
      assert.equal(response.exceptionDetails, undefined, response.exceptionDetails?.exception?.description);
      return response.result.value;
    };
    const until = async expression => {
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        if (await evaluate(expression)) return;
        await wait(100);
      }
      assert.fail(`Timed out: ${expression}\n${await evaluate('document.body.innerText')}`);
    };
    const click = async point => {
      await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
    };
    const controls = () => evaluate(`(() => {
      const visible = selector => [...document.querySelectorAll(selector)].find(el => {
        const r = el.getBoundingClientRect();
        return r.width && getComputedStyle(el).visibility !== 'hidden' && el.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      const rect = el => { const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };
      const toggle = visible('button[aria-label="Switch to preview mode"], button[aria-label="Switch to edit mode"]');
      const find = visible('button[title="Find in file"]');
      return toggle && find ? { toggle: rect(toggle), find: rect(find), label: toggle.getAttribute('aria-label') } : null;
    })()`);
    const toolbarIcons = () => evaluate(`(() => {
      const toggle = document.querySelector('button[aria-label="Switch to preview mode"], button[aria-label="Switch to edit mode"]');
      const toolbar = toggle?.closest('div.pointer-events-auto');
      return [...(toolbar?.querySelectorAll('button') ?? [])].filter(el => el.getBoundingClientRect().width && getComputedStyle(el).visibility !== 'hidden').map(el => el.querySelector('use')?.getAttribute('href')?.replace('#oc-', ''));
    })()`);
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.send('Page.navigate', { url });
    await until('document.readyState === "complete" && !!document.querySelector("#root")?.children.length');
    await until(`!!document.querySelector('button[aria-label="Send message"]')`);
    await evaluate(`(async () => {
      const { useDirectoryStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useDirectoryStore.ts`)});
      useDirectoryStore.getState().setDirectory(${JSON.stringify(directory)});
      const { useSessionUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/sync/session-ui-store.ts`)});
      useSessionUIStore.getState().openNewSessionDraft({ directoryOverride: ${JSON.stringify(directory)} });
    })()`);
    await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    await evaluate(`(async () => {
      const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
      useUIStore.getState().openContextFile(${JSON.stringify(directory)}, ${JSON.stringify(file)});
      if (useUIStore.getState().contextEditorTreeVisible) useUIStore.getState().toggleContextEditorTree();
    })()`);
    await until(`!!document.querySelector('button[aria-label="Switch to preview mode"], button[aria-label="Switch to edit mode"]')`);
    // The initial Markdown mode is remembered independently of the file.
    let first = await controls();
    if (first.label === 'Switch to edit mode') {
      await click(first.toggle);
      await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
    }
    await until(`!![...document.querySelectorAll('.cm-line')].find(el => el.textContent.includes('needle'))`);
    let expanded = false;
    for (const scenario of [
      { width: 1440, direction: 'ltr', tts: false, expanded: false },
      { width: 1440, direction: 'ltr', tts: true, expanded: false },
      { width: 900, direction: 'ltr', tts: true, expanded: false },
      { width: 900, direction: 'rtl', tts: true, expanded: false },
      { width: 1440, direction: 'ltr', tts: true, expanded: true },
      { width: 1440, direction: 'rtl', tts: true, expanded: true },
      { width: 1440, direction: 'ltr', tts: true, expanded: true, tree: true, autoSave: false },
      { width: 900, direction: 'ltr', tts: true, expanded: true, touch: true },
    ]) {
      const { width, direction, tts } = scenario;
      const label = JSON.stringify(scenario);
      await client.send('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false });
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: scenario.touch === true, maxTouchPoints: 1 });
      await evaluate(`(async () => {
        const { useConfigStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useConfigStore.ts`)});
        useConfigStore.getState().setShowMessageTTSButtons(${tts});
        const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
        useUIStore.getState().setAutoSaveEnabled(${scenario.autoSave !== false});
        if (useUIStore.getState().contextEditorTreeVisible !== ${scenario.tree === true}) useUIStore.getState().toggleContextEditorTree();
      })()`);
      await evaluate(`document.documentElement.dir = ${JSON.stringify(direction)}`);
      if (expanded !== scenario.expanded) {
        await evaluate(`(async () => {
          const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
          useUIStore.getState().toggleContextPanelExpanded(${JSON.stringify(directory)}, 'right');
        })()`);
        expanded = scenario.expanded;
      }
      await until(`!document.getAnimations().some(animation => animation.playState === 'running' && animation.effect?.getTiming().iterations !== Infinity)`);
      // Wait for two real layout frames before reading both modes' geometry.
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      first = await controls();
      assert.ok(first, `${label}: source controls are visible and clickable`);
      const icons = await toolbarIcons();
      assert.ok(icons.indexOf('search') < icons.indexOf('eye-off'), `${label}: Find precedes preview toggle: ${icons}`);
      assert.ok(icons.indexOf('eye-off') < icons.indexOf('text-wrap') || !icons.includes('text-wrap'), `${label}: preview toggle precedes secondary actions: ${icons}`);
      await click(first.toggle);
      await until(`!!document.querySelector('button[aria-label="Switch to edit mode"]')`);
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      const preview = await controls();
      assert.ok(preview, `${label}: preview controls are visible and clickable`);
      assert.ok(Math.abs(preview.toggle.x - first.toggle.x) <= 1, `${label}: preview toggle moved from ${first.toggle.x} to ${preview.toggle.x}`);
      assert.ok(Math.abs(preview.find.x - first.find.x) <= 1, `${label}: Find moved from ${first.find.x} to ${preview.find.x}`);
      assert.equal(preview.toggle.y, first.toggle.y, `${label}: toolbar stays on one row`);
      const previewIcons = await toolbarIcons();
      const common = items => items.filter(icon => !['file-check-fill', 'file-check', 'eye-off', 'eye', 'volume-up'].includes(icon));
      assert.deepEqual(common(previewIcons), common(icons), `${label}: common actions retain order and visibility`);
      assert.ok(!previewIcons.includes('file-check-fill') && !previewIcons.includes('file-check'), `${label}: autosave remains hidden in preview`);
      assert.ok(previewIcons.indexOf('search') < previewIcons.indexOf('eye'), `${label}: preview Find precedes the eye`);
      if (previewIcons.includes('more')) {
        await evaluate(`document.querySelector('button[aria-label="More actions"]').click()`);
        await until(`!!document.querySelector('[role="menuitem"]')`);
        const menuIcons = await evaluate(`[...document.querySelectorAll('[role="menuitem"] use')].map(el => el.getAttribute('href').replace('#oc-', ''))`);
        const allIcons = [...previewIcons.filter(icon => icon !== 'more'), ...menuIcons];
        for (const icon of ['text-wrap', 'menu-fold-2', 'list-unordered', 'clipboard', 'file-copy-2', 'download']) {
          assert.equal(allIcons.filter(value => value === icon).length, 1, `${label}: ${icon} remains available once inline or in overflow`);
        }
        assert.equal(allIcons.includes('volume-up'), tts, `${label}: Read aloud visibility follows preview setting`);
        await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await until(`!document.querySelector('[role="menuitem"]')`);
      }
      // Clicking the same screen point must switch back, not open Find.
      await click(first.toggle);
      await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
      assert.equal(await evaluate(`!!document.querySelector('input[placeholder="Find in preview"]')`), false);
    }
    await client.send('Emulation.setTouchEmulationEnabled', { enabled: false });
    await evaluate(`(async () => {
      const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
      useUIStore.getState().setAutoSaveEnabled(false);
    })()`);
    // The stable Find button must still search the active viewer.
    await click((await controls()).find);
    await until(`!!document.querySelector('.cm-search input[name="search"]')`);
    await evaluate(`document.querySelector('.cm-search input[name="search"]').focus()`);
    await client.send('Input.insertText', { text: 'needle' });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'e', code: 'KeyE', windowsVirtualKeyCode: 69 });
    await until(`document.querySelector('.cm-search-message')?.textContent === '1/2'`);
    await evaluate(`document.querySelector('.cm-search button[name="close"]').click()`);
    await click((await controls()).toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to edit mode"]')`);
    await click((await controls()).find);
    await until(`document.activeElement?.getAttribute('placeholder') === 'Find in preview'`);
    await client.send('Input.insertText', { text: 'needle' });
    await until(`[...document.querySelectorAll('[aria-live="polite"]')].some(el => el.textContent === '1/2')`);
    await evaluate(`document.querySelector('button[aria-label="Close search"]').click()`);
    await until(`!document.querySelector('input[placeholder="Find in preview"]')`);
    await click((await controls()).toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
    await evaluate(`(() => {
      const editor = [...document.querySelectorAll('.cm-editor')].find(el => el.textContent.includes('# Toolbar regression'));
      editor.querySelector('.cm-content').focus();
    })()`);
    await client.send('Input.insertText', { text: ' ' });
    await until(`!!document.querySelector('button use[href="#oc-save-3"]')`);
    const saveGap = await evaluate(`(() => {
      const save = document.querySelector('button use[href="#oc-save-3"]').closest('button').getBoundingClientRect();
      const autoSave = document.querySelector('button[aria-label="Manual save"]').getBoundingClientRect();
      return autoSave.left - save.right;
    })()`);
    assert.ok(saveGap <= 4.5, `Save and autosave keep the original 4px gap, got ${saveGap}px`);
    const dirty = await controls();
    await click(dirty.toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to edit mode"]')`);
    const dirtyPreview = await controls();
    assert.equal(dirtyPreview.toggle.x, dirty.toggle.x, 'unsaved manual-save controls keep their reserved width');
    assert.equal(dirtyPreview.find.x, dirty.find.x, 'unsaved manual-save controls do not displace Find');
    await click(dirty.toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
    await evaluate(`[...document.querySelectorAll('.cm-editor')].find(el => el.textContent.includes('# Toolbar regression')).querySelector('.cm-content').focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.send('Input.insertText', { text: fixtureContent });
    await until(`!document.querySelector('button use[href="#oc-save-3"]')`);
    await evaluate(`(async () => {
      const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
      useUIStore.getState().setAutoSaveEnabled(true);
    })()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.send('Input.insertText', { text: fixtureContent + ' ' });
    await until(`!!document.querySelector('button use[href="#oc-save-3"]')`);
    await click((await controls()).toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to edit mode"]')`);
    await until(`!!document.querySelector('span[inert] span[class*="status-success"]')`);
    await until(`!document.querySelector('span[inert] span[class*="status-success"]')`);
    await click((await controls()).toggle);
    await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
    await evaluate(`[...document.querySelectorAll('.cm-editor')].find(el => el.textContent.includes('# Toolbar regression')).querySelector('.cm-content').focus()`);
    await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
    await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 });
    await client.send('Input.insertText', { text: fixtureContent });
    await until(`!!document.querySelector('span[class*="status-success"]')`);
    if (codeFile) {
      await evaluate(`(async () => {
        const { useUIStore } = await import(${JSON.stringify(`/@fs${repo}/packages/ui/src/stores/useUIStore.ts`)});
        useUIStore.getState().openContextFile(${JSON.stringify(directory)}, ${JSON.stringify(codeFile)});
        if (useUIStore.getState().contextEditorTreeVisible) useUIStore.getState().toggleContextEditorTree();
      })()`);
      await until(`!![...document.querySelectorAll('.cm-line')].find(el => el.textContent.includes('toolbar regression'))`);
      let codeControls = await controls();
      if (codeControls?.label === 'Switch to edit mode') {
        await click(codeControls.toggle);
        await until(`!!document.querySelector('button[aria-label="Switch to preview mode"]')`);
        codeControls = await controls();
      }
      const editIcons = await toolbarIcons();
      const saveIcon = editIcons.includes('file-check-fill') ? 'file-check-fill' : 'file-check';
      assert.deepEqual(editIcons, [saveIcon, 'search', 'eye-off', 'text-wrap', 'menu-fold-2', 'list-unordered', 'clipboard', 'file-copy-2', 'download']);
      assert.ok(codeControls, 'code editor retains Find and its preview toggle');
      await click(codeControls.toggle);
      await until(`!!document.querySelector('button[aria-label="Switch to edit mode"]')`);
      assert.deepEqual(await toolbarIcons(), ['eye', 'text-wrap', 'clipboard', 'file-copy-2', 'download']);
      assert.equal(await evaluate(`!!document.querySelector('button[title="Find in file"]')`), false, 'code view keeps Find hidden');
    }
  } finally {
    client?.close();
    if (browser && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      await Promise.race([exited, wait(3_000)]);
      if (browser.exitCode === null) browser.kill('SIGKILL');
    }
    rmSync(profile, { recursive: true, force: true });
  }
});
