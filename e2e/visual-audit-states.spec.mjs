import { test, expect } from '@playwright/test';
import {
  VIEWPORTS,
  setupApi,disposeApi,newPage,capture,expectVisualIntegrity,seedPopulatedExtremeState
} from './wave14-fixture.mjs';

async function go(page,hash,heading){
  await page.evaluate(value=>{location.hash=value;},hash);
  await expect(page.locator('#pageHeading')).toHaveText(heading);
}

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test.describe.serial('Wave 14 loading and error states',()=>{
  test.beforeAll(async()=>{await setupApi();await seedPopulatedExtremeState();});
  test.afterAll(async()=>{await disposeApi();});

  for(const scenario of [
    {name:'mobile-dark',view:VIEWPORTS[0],theme:'dark'},
    {name:'desktop-light',view:VIEWPORTS[2],theme:'light'}
  ]){
    test(`${scenario.name}: Bank Feed, schedules and Settings loading/error states`,async({browser})=>{
      test.setTimeout(120_000);
      const {context,page}=await newPage(browser,scenario.view,scenario.theme);

      await page.route('**/api/bank-feed**',async route=>{await sleep(1200);await route.continue();});
      await go(page,'#bank','Bank Feed');
      await expect(page.getByText(/Loading bank feed/)).toBeVisible();
      await expectVisualIntegrity(page,'bank loading');
      await capture(page,'state',scenario.view.name,scenario.theme,'bank-loading');
      await expect(page.getByText(/Loading bank feed/)).toHaveCount(0,{timeout:10_000});
      await page.unrouteAll({behavior:'wait'});

      await page.route('**/api/bank-feed**',route=>route.fulfill({
        status:500,contentType:'application/json',
        body:'{"error":"Visual audit simulated bank error with a deliberately long message that must stay inside the viewport."}'
      }));
      await go(page,'#dashboard','Dashboard');
      await go(page,'#bank','Bank Feed');
      await expect(page.getByText('Could not load bank feed')).toBeVisible();
      await expectVisualIntegrity(page,'bank error');
      await capture(page,'state',scenario.view.name,scenario.theme,'bank-error');
      await page.unrouteAll({behavior:'wait'});

      await page.route('**/api/recurring**',async route=>{await sleep(1200);await route.continue();});
      await go(page,'#scheduled','Scheduled & Reminders');
      await expect(page.getByText(/Loading recurring schedules/)).toBeVisible();
      await expectVisualIntegrity(page,'scheduled loading');
      await capture(page,'state',scenario.view.name,scenario.theme,'scheduled-loading');
      await expect(page.getByText(/Loading recurring schedules/)).toHaveCount(0,{timeout:10_000});
      await page.unrouteAll({behavior:'wait'});

      await page.route('**/api/recurring**',route=>route.fulfill({
        status:500,contentType:'application/json',
        body:'{"error":"Visual audit simulated recurring error with a long readable message."}'
      }));
      await go(page,'#dashboard','Dashboard');
      await go(page,'#scheduled','Scheduled & Reminders');
      await expect(page.getByText(/Visual audit simulated recurring error/)).toBeVisible();
      await expectVisualIntegrity(page,'scheduled error');
      await capture(page,'state',scenario.view.name,scenario.theme,'scheduled-error');
      await page.unrouteAll({behavior:'wait'});

      const settingsPattern=/\/api\/(?:users|ops\/status|auth\/sessions|security\/events)$/;
      await page.route(settingsPattern,async route=>{await sleep(1200);await route.continue();});
      await go(page,'#settings','Settings');
      await expect(page.getByText(/Loading diagnostics|Loading accounts|Loading sessions/).first()).toBeVisible();
      await expectVisualIntegrity(page,'settings loading');
      await capture(page,'state',scenario.view.name,scenario.theme,'settings-loading');
      await page.waitForTimeout(1400);
      await page.unrouteAll({behavior:'wait'});

      await page.route(settingsPattern,route=>route.fulfill({
        status:500,contentType:'application/json',
        body:'{"error":"Visual audit simulated settings diagnostics error."}'
      }));
      await go(page,'#dashboard','Dashboard');
      await go(page,'#settings','Settings');
      await page.waitForTimeout(250);
      await expect(page.getByText(/Could not|simulated settings diagnostics error/i).first()).toBeVisible();
      await expectVisualIntegrity(page,'settings error');
      await capture(page,'state',scenario.view.name,scenario.theme,'settings-error');
      await page.unrouteAll({behavior:'wait'});

      await context.close();
    });
  }
});
