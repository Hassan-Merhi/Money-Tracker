import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');

function hexToRgb(hex){
  const raw=String(hex).replace('#','');
  return [0,2,4].map(i=>parseInt(raw.slice(i,i+2),16));
}
function channel(v){
  const c=v/255;
  return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;
}
function luminance(hex){
  const [r,g,b]=hexToRgb(hex).map(channel);
  return .2126*r+.7152*g+.0722*b;
}
function contrast(a,b){
  const x=luminance(a),y=luminance(b),hi=Math.max(x,y),lo=Math.min(x,y);
  return (hi+.05)/(lo+.05);
}

test('Wave 11: standalone import dialogs are named, keyboard trapped, escapable, and return focus',()=>{
  const source=read('block-c-import.js');
  assert.match(source,/aria-labelledby="impQuickTitle"/);
  assert.match(source,/id="impQuickTitle"/);
  assert.match(source,/aria-labelledby="impTitle"/);
  assert.match(source,/id="impTitle"/);
  assert.match(source,/function activateImporterDialog\(wrap\)/);
  assert.match(source,/event\.key==='Escape'/);
  assert.match(source,/event\.key!=='Tab'/);
  assert.match(source,/importerReturnFocus/);
  assert.match(source,/restore\?\.isConnected/);
  assert.match(source,/aria-live="polite"/);
});

test('Wave 11: import controls have programmatic labels',()=>{
  const source=read('block-c-import.js');
  assert.match(source,/label for="\$\{id\}"/);
  assert.match(source,/label for="impMode"/);
  assert.match(source,/id="impSheet" aria-label="Workbook sheet"/);
  assert.match(source,/id="impQuickPaste"[^>]+aria-label="Excel rows to import"/);
});

test('Wave 11: main app preserves focus, reduced-motion, and coarse-pointer contracts',()=>{
  const app=read('app.js'),css=read('styles.css');
  assert.match(app,/aria-labelledby="\$\{titleId\}"/);
  assert.match(app,/event\.key==='Escape'/);
  assert.match(app,/event\.key!=='Tab'/);
  assert.match(app,/modalReturnFocus/);
  assert.match(css,/:where\(button,a,input,select,textarea,\[role="button"\]\):focus-visible/);
  assert.match(css,/@media\(pointer:coarse\)[^\n]+min-width:44px;min-height:44px/);
  assert.match(css,/@media\(prefers-reduced-motion:reduce\)/);
});

test('Wave 11: positive-state text meets WCAG AA contrast in the light theme',()=>{
  const css=read('styles.css');
  const green=/--green:(#[0-9a-fA-F]{6})/.exec(css)?.[1];
  const greenBg=/--green-bg:(#[0-9a-fA-F]{6})/.exec(css)?.[1];
  assert.ok(green&&greenBg);
  assert.ok(contrast(green,'#ffffff')>=4.5,`green on white contrast was ${contrast(green,'#ffffff').toFixed(2)}`);
  assert.ok(contrast(green,greenBg)>=4.5,`green on green background contrast was ${contrast(green,greenBg).toFixed(2)}`);
});
