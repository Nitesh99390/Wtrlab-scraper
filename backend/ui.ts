export const WTR_MENU_BUTTON = '🌐 WTR-Lab Novels';

export const MAIN_MENU_KEYBOARD = {
  keyboard: [[{ text: WTR_MENU_BUTTON }], [{ text: 'ℹ️ Help' }, { text: '📊 Status' }]],
  resize_keyboard: true,
  is_persistent: true,
};

export const START_TEXT =
  `👋 <b>Welcome to the WTR-Lab Novel Downloader!</b>\n\n` +
  `Main kisi bhi <b>WTR-Lab</b> novel ko EPUB / TXT me download karke de sakta hoon - ` +
  `<b>zero missing, zero duplicate chapters</b> ke verification ke saath.\n\n` +
  `🚀 <b>Quick start</b>\n` +
  `• <code>/wtr</code> - live trending novels\n` +
  `• <code>/wtr &lt;name or ID&gt;</code> - search (jaise <code>/wtr 7226</code>)\n` +
  `• Ya seedha koi <b>wtr-lab.com</b> novel link bhej do\n\n` +
  `Type /help for all commands.`;

export const HELP_TEXT =
  `📖 <b>WTR-Lab Bot - Help</b>\n\n` +
  `<b>Commands</b>\n` +
  `/start - welcome message\n` +
  `/help - ye help\n` +
  `/wtr or /wtrlab - trending novels\n` +
  `/wtr &lt;name | ID | URL&gt; - search ya direct novel card\n` +
  `/format &lt;epub|txt&gt; - output format choose karein\n` +
  `/status - aapke running / queued downloads\n` +
  `/cancel - aapke downloads cancel karein\n\n` +
  `<b>Novel card buttons</b>\n` +
  `⚡ <b>Demo</b> - pehle 25 chapters\n` +
  `⚙️ <b>Custom Range</b> - apni range (jaise <code>10-50</code>)\n` +
  `📚 <b>All</b> - poori novel\n` +
  `🇬🇧/🇮🇳 - English ya Hindi edition\n` +
  `Web / Web+ / AI - cleanup engine\n\n` +
  `✅ Har file bhejne se pehle verify hoti hai: koi chapter missing ya duplicate hua to delivery block ho jaati hai.`;
