import { expect, test } from './fixtures/index.js';
import { navigateTo } from './helpers';

test('cached radio observations appear in modem details and open their readings without action controls', async ({ authedPage: page }) => {
 await navigateTo(page,'network');
 await page.getByTestId('modem-details-toggle').first().click();
 const panel=page.getByTestId('radio-health').first();
 await expect(panel).toBeVisible({timeout:65000});
 await expect(panel).toContainText('Radio health');
 await expect(panel).toContainText('Unavailable');
 // One button opens the readings; nothing in the panel acts on the modem.
 await expect(panel.locator('input,select')).toHaveCount(0);
 await expect(panel.locator('button')).toHaveCount(1);
 const open=panel.getByTestId('radio-health-open');
 // A short window makes the dialog body overflow on both projects.
 const size=page.viewportSize();
 if(size) await page.setViewportSize({width:size.width,height:360});
 await open.click();
 const details=page.getByTestId('radio-health-details');
 await expect(details).toBeVisible();
 // The read-only body is a tab stop: the keyboard reaches it with Tab.
 let tabs=0;
 do {
  await page.keyboard.press('Tab');
  tabs++;
 } while(tabs<6&&!(await details.evaluate((el)=>el===document.activeElement)));
 await expect(details).toBeFocused();
 // Page Down then scrolls the overflowing body.
 const scroller=async()=>details.evaluate((el)=>{
  for(let node:HTMLElement|null=el;node;node=node.parentElement){
   const style=getComputedStyle(node);
   if(/(auto|scroll)/.test(style.overflowY)&&node.scrollHeight>node.clientHeight) return {top:node.scrollTop,room:node.scrollHeight-node.clientHeight};
  }
  return null;
 });
 const before=await scroller();
 expect(before?.room??0).toBeGreaterThan(0);
 await page.keyboard.press('PageDown');
 await expect.poll(async()=>(await scroller())?.top??0).toBeGreaterThan(before?.top??0);
 await page.keyboard.press('Escape');
 await expect(details).toBeHidden();
 await expect(open).toBeFocused();
 await expect(panel).not.toContainText('Weak signal');
});
