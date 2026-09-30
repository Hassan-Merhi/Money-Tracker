import { test, expect } from '@playwright/test';
import {
  VIEWPORTS,THEMES,ROUTES,
  setupApi,disposeApi,newPage,openRoute,capture,expectVisualIntegrity,seedPopulatedExtremeState
} from './wave14-fixture.mjs';

async function closeAppModal(page){
  await page.locator('#modalClose').click();
  await expect(page.locator('.modal')).toHaveCount(0);
}

test.describe.serial('Wave 14 modal and menu containment',()=>{
  test.beforeAll(async()=>{await setupApi();await seedPopulatedExtremeState();});
  test.afterAll(async()=>{await disposeApi();});

  for(const view of VIEWPORTS){
    for(const theme of THEMES){
      test(`${view.name} ${theme}: major dialogs and menus stay inside the viewport`,async({browser})=>{
        test.setTimeout(120_000);
        const {context,page,assertClean}=await newPage(browser,view,theme);

        await openRoute(page,ROUTES[0]);
        await page.locator('#quickEntry').click();
        await expect(page.locator('.modal')).toBeVisible();
        await expectVisualIntegrity(page,'quick-entry modal');
        await capture(page,'overlay',view.name,theme,'quick-entry-modal');
        await closeAppModal(page);

        await openRoute(page,ROUTES[1]);
        await page.locator('#addPerson').click();
        await expect(page.locator('.modal')).toBeVisible();
        await expectVisualIntegrity(page,'add-person modal');
        await capture(page,'overlay',view.name,theme,'add-person-modal');
        await closeAppModal(page);

        await page.locator('#peopleImport').click();
        await expect(page.getByRole('dialog',{name:'Import people & statements'})).toBeVisible();
        await expectVisualIntegrity(page,'import choices modal');
        await capture(page,'overlay',view.name,theme,'import-choices-modal');
        await page.locator('#peopleImportFile').click();
        await expect(page.locator('.imp-shell')).toBeVisible();
        await expectVisualIntegrity(page,'spreadsheet importer');
        await capture(page,'overlay',view.name,theme,'spreadsheet-importer');
        await page.locator('.imp-close').click();
        await expect(page.locator('.imp-shell')).toHaveCount(0);

        await openRoute(page,ROUTES[2]);
        await page.locator('#transferBtn').click();
        await expect(page.locator('.modal')).toBeVisible();
        await expectVisualIntegrity(page,'transfer modal');
        await capture(page,'overlay',view.name,theme,'transfer-modal');
        await closeAppModal(page);

        await page.locator('.account-card').first().click();
        await expect(page.locator('.modal')).toBeVisible();
        await expectVisualIntegrity(page,'account detail modal');
        await capture(page,'overlay',view.name,theme,'account-detail-modal');
        await closeAppModal(page);

        await openRoute(page,ROUTES[3]);
        const menuTrigger=page.locator('[data-menu-trigger]').first();
        await menuTrigger.click();
        await expect(page.locator('.entry-menu-popover:not([hidden])')).toBeVisible();
        await expectVisualIntegrity(page,'transaction menu');
        await capture(page,'overlay',view.name,theme,'transaction-menu');
        await menuTrigger.click();
        await expect(page.locator('.entry-menu-popover:not([hidden])')).toHaveCount(0);

        await openRoute(page,ROUTES[6]);
        await page.locator('#newRecurring').click();
        await expect(page.locator('.modal')).toBeVisible();
        await expectVisualIntegrity(page,'recurring modal');
        await capture(page,'overlay',view.name,theme,'recurring-modal');
        await closeAppModal(page);

        await openRoute(page,ROUTES[7]);
        await page.locator('#reportExportTrigger').click();
        await expect(page.locator('#reportExportMenu')).toBeVisible();
        await expectVisualIntegrity(page,'report export menu');
        await capture(page,'overlay',view.name,theme,'report-export-menu');
        await page.locator('#reportExportTrigger').click();
        await expect(page.locator('#reportExportMenu')).toBeHidden();

        await openRoute(page,ROUTES[8]);
        await page.locator('#resetData').click();
        await expect(page.getByRole('dialog',{name:'Delete all app data'})).toBeVisible();
        await expectVisualIntegrity(page,'danger confirmation modal');
        await capture(page,'overlay',view.name,theme,'danger-confirmation-modal');
        await closeAppModal(page);

        if(view.name==='mobile'){
          await page.locator('#mobileMore').click();
          await expect(page.getByRole('dialog',{name:'Your workspace'})).toBeVisible();
          await expectVisualIntegrity(page,'mobile More modal');
          await capture(page,'overlay',view.name,theme,'mobile-more-modal');
          await closeAppModal(page);
        }

        assertClean();
        await context.close();
      });
    }
  }
});
