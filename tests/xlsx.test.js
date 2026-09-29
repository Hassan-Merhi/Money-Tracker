import test from 'node:test';
import assert from 'node:assert/strict';
import { buildXlsx } from '../lib/xlsx.js';

test('buildXlsx creates a valid-looking OOXML zip with workbook parts',()=>{
  const b=buildXlsx([{name:'Overview',rows:[['Hello',123]]},{name:'People',rows:[['Name'],['Alice']]}]);
  assert.equal(b[0],0x50);
  assert.equal(b[1],0x4b);
  const text=new TextDecoder().decode(b);
  assert.match(text,/\[Content_Types\]\.xml/);
  assert.match(text,/xl\/workbook\.xml/);
  assert.match(text,/worksheets\/sheet2\.xml/);
  assert.match(text,/Alice/);
  assert.match(text,/autoFilter/);
  assert.match(text,/state="frozen"/);
  assert.match(text,/customWidth="1"/);
});
