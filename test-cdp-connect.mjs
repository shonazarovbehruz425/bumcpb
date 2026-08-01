import { chromium } from 'playwright';

async function test() {
  console.log('Attempting to connect to Chrome on CDP port 9222...');
  try {
    const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
    console.log('✅ Connected successfully!');
    
    const contexts = browser.contexts();
    console.log(`Contexts found: ${contexts.length}`);
    
    if (contexts.length > 0) {
      const context = contexts[0];
      const pages = context.pages();
      console.log(`Pages in first context: ${pages.length}`);
      
      if (pages.length > 0) {
        const page = pages[0];
        const url = await page.url();
        const title = await page.title();
        console.log(`Current page: ${url}`);
        console.log(`Title: ${title}`);
      }
    }
    
    await browser.close();
  } catch (e) {
    console.error('❌ Connection failed:', e.message);
  }
}

test();
