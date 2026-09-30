import { test, expect } from '@playwright/test';
import {
  VIEWPORTS,THEMES,ROUTES,
  setupApi,disposeApi,currentState,newPage,openRoute,capture,expectVisualIntegrity,
  seedPopulatedExtremeState
} from './wave14-fixture.mjs';

test.describe.serial('Wave 14 page matrix',()=>{
  test.beforeAll(async()=>{await setupApi();});
  test.afterAll(async()=>{await disposeApi();});

  test('empty advanced workspace across every page, viewport and theme',async({browser})=>{
    test.setTimeout(240_000);
    for(const view of VIEWPORTS){
      for(const theme of THEMES){
        const {context,page,assertClean}=await newPage(browser,view,theme,{authScreenshot:true});
        for(const route of ROUTES){
          await openRoute(page,route);
          await expectVisualIntegrity(page,`empty ${view.name} ${theme} ${route.slug}`);
          await capture(page,'empty',view.name,theme,route.slug);
        }
        assertClean();
        await context.close();
      }
    }
  });

  test('seed long names, huge values, multiple currencies and populated feature data',async()=>{
    await seedPopulatedExtremeState();
    const state=await currentState();
    expect(state.people.length).toBeGreaterThanOrEqual(4);
    expect(state.accounts.length).toBeGreaterThanOrEqual(4);
    expect(state.entries.length).toBeGreaterThanOrEqual(10);
    expect(new Set(state.entries.map(entry=>entry.currency).filter(Boolean)).size).toBeGreaterThanOrEqual(4);
  });

  test('populated extreme workspace across every page, viewport and theme',async({browser})=>{
    test.setTimeout(300_000);
    const routes=[...ROUTES,{slug:'person-statement',hash:'#person?id=person_long',heading:'Person statement'}];
    for(const view of VIEWPORTS){
      for(const theme of THEMES){
        const {context,page,assertClean}=await newPage(browser,view,theme);
        for(const route of routes){
          await openRoute(page,route);
          await expectVisualIntegrity(page,`populated ${view.name} ${theme} ${route.slug}`);
          await capture(page,'populated',view.name,theme,route.slug);
        }
        assertClean();
        await context.close();
      }
    }
  });
});
