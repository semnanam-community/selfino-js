// ─────────────────────────────────────────────
// تنظیمات
// ─────────────────────────────────────────────
const RAMADAN_MODE     = true;
const GROUP_ID         = -1002446115272;
const TOPIC_ID         = 55235;
const REQUIRED_CHANNEL = '@semnanam';
const BROADCAST_BATCH  = 25;   // تعداد پیام در هر دسته
const BROADCAST_DELAY  = 1100; // تأخیر بین هر دسته (میلی‌ثانیه)

let DB, BOT_TOKEN, CTX;  // CTX = ExecutionContext for waitUntil

// ─────────────────────────────────────────────
// توابع کمکی تاریخ
// ─────────────────────────────────────────────
function tehranNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Tehran' }));
}

function isoWeek(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const y = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil((((t - y) / 864e5) + 1) / 7);
}

function fmt(pattern) {
  const d  = tehranNow();
  const Y  = d.getFullYear();
  const m  = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const H  = String(d.getHours()).padStart(2, '0');
  const i  = String(d.getMinutes()).padStart(2, '0');
  const s  = String(d.getSeconds()).padStart(2, '0');
  const W  = String(isoWeek(d)).padStart(2, '0');
  const map = {
    'Y-m-d':       `${Y}-${m}-${dd}`,
    'Y-m-d H:i:s': `${Y}-${m}-${dd} ${H}:${i}:${s}`,
    'Y-m-d H':     `${Y}-${m}-${dd} ${H}`,
    'Y-W':         `${Y}-${W}`,
    'Y-m':         `${Y}-${m}`,
  };
  return map[pattern] ?? map['Y-m-d'];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// هش
// ─────────────────────────────────────────────
async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

// ─────────────────────────────────────────────
// لاگ
// ─────────────────────────────────────────────
function log(userId, action, details = '') {
  console.log(`[${fmt('Y-m-d H:i:s')}] User:${userId} | ${action} | ${details}`);
}

// ─────────────────────────────────────────────
// API تلگرام
// ─────────────────────────────────────────────
async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}

async function sendMessage(chatId, text, markup = null) {
  const p = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (markup) p.reply_markup = typeof markup === 'string' ? JSON.parse(markup) : markup;
  const res = await tg('sendMessage', p);
  const mid = res?.result?.message_id ?? null;
  if (mid) {
    const st = await getState(chatId) ?? {};
    st.last_message_id = mid;
    await saveState(chatId, st);
  }
  log(chatId, 'SEND', text.slice(0, 60));
  return mid;
}

async function deleteMsg(chatId, mid) {
  try { await tg('deleteMessage', { chat_id: chatId, message_id: mid }); }
  catch (e) { log(chatId, 'DEL_ERR', e.message); }
}

async function editText(chatId, mid, text, markup = null) {
  const p = { chat_id: chatId, message_id: mid, text, parse_mode: 'HTML' };
  if (markup) p.reply_markup = typeof markup === 'string' ? JSON.parse(markup) : markup;
  return tg('editMessageText', p);
}

async function editMarkup(chatId, mid, markup) {
  return tg('editMessageReplyMarkup', {
    chat_id: chatId, message_id: mid,
    reply_markup: typeof markup === 'string' ? JSON.parse(markup) : markup,
  });
}

async function sendToTopic(chatId, threadId, text, markup = null) {
  const p = { chat_id: chatId, message_thread_id: threadId, text,
              parse_mode: 'HTML', disable_web_page_preview: true };
  if (markup) p.reply_markup = typeof markup === 'string' ? JSON.parse(markup) : markup;
  const r = await tg('sendMessage', p);
  return r?.ok ? r.result.message_id : null;
}

async function isMember(userId, chat) {
  let cid = chat;
  if (typeof chat === 'string' && chat.startsWith('@')) {
    const c = await tg('getChat', { chat_id: chat });
    if (!c?.ok) return false;
    cid = c.result.id;
  }
  const r = await tg('getChatMember', { chat_id: cid, user_id: userId });
  return r?.ok && ['member','administrator','creator'].includes(r.result.status);
}

async function fetchUsername(userId) {
  if (!userId || userId <= 0) return null;
  try {
    const r = await tg('getChat', { chat_id: userId });
    return r?.ok ? (r.result.username ?? `user_${userId}`) : null;
  } catch { return null; }
}


async function safeSend(method, payload) {
  let retries = 0;
  while (retries < 3) {
    try {
      const res = await tg(method, payload);
      if (res.ok) return { ok: true, result: res.result };
      
      // هندلینگ Rate Limit
      if (res.error_code === 429) {
        const wait = (res.parameters?.retry_after || 1) + 1;
        // log(0, 'RATE_LIMIT', `Waiting ${wait}s`); // اختیاری برای دیباگ
        await sleep(wait * 1000);
        continue; // تلاش مجدد
      }

      // هندلینگ بلاک شدن توسط کاربر
      if (res.error_code === 403 || (res.description && res.description.includes('blocked'))) {
        return { ok: false, error: 'blocked', uid: payload.chat_id };
      }

      return { ok: false, error: res.description };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
  return { ok: false, error: 'max_retries' };
}

function getProgressBar(percent) {
  const total = 10;
  const filled = Math.round((percent / 100) * total);
  const empty = total - filled;
  return '▓'.repeat(filled) + '░'.repeat(empty);
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
// دیتابیس
// ─────────────────────────────────────────────

/* ── ادمین ── */
async function isAdmin(uid) {
  return !!(await DB.prepare('SELECT 1 FROM admins WHERE user_id=?').bind(uid).first());
}
async function allAdmins() {
  const { results } = await DB.prepare('SELECT user_id,username FROM admins').all();
  const m = {}; results.forEach(r => m[r.user_id] = r.username); return m;
}
async function addAdmin(by, uid, uname) {
  if (!uid || uid <= 0) return false;
  if (await DB.prepare('SELECT 1 FROM admins WHERE user_id=?').bind(uid).first()) return false;
  try {
    await DB.prepare('INSERT INTO admins(user_id,username,added_by) VALUES(?,?,?)').bind(uid,uname,by).run();
    return true;
  } catch { return false; }
}
async function removeAdmin(uid) {
  await DB.prepare('DELETE FROM admins WHERE user_id=?').bind(uid).run();
  return true;
}

/* ── سلف ── */
async function allDinings() {
  const { results } = await DB.prepare('SELECT id,name FROM dinings').all();
  return results;
}
async function addDining(by, name) {
  try {
    await DB.prepare('INSERT INTO dinings(name,added_by) VALUES(?,?)').bind(name,by).run();
    log(by,'DINING_ADD',name); return true;
  } catch { return false; }
}
async function removeDining(id) {
  await DB.prepare('DELETE FROM dinings WHERE id=?').bind(id).run();
  return true;
}

/* ── ارسال ── */
async function canSubmit(uid) {
  if (await isAdmin(uid)) return true;
  const today = fmt('Y-m-d');
  const r = await DB.prepare(
    'SELECT SUM(count) AS t FROM submissions WHERE user_id=? AND submission_date=?'
  ).bind(uid,today).first();
  return (r?.t ?? 0) < 3;
}

async function addSubmission(uid) {
  const today = fmt('Y-m-d');
  await DB.prepare(
    `INSERT INTO submissions(user_id,submission_date,count) VALUES(?,?,1)
     ON CONFLICT(user_id,submission_date) DO UPDATE SET count=count+1`
  ).bind(uid,today).run();
}

async function remainingMsg(uid) {
  const today = fmt('Y-m-d');
  const r = await DB.prepare(
    'SELECT SUM(count) AS t FROM submissions WHERE user_id=? AND submission_date=? AND deleted=0'
  ).bind(uid,today).first();
  const rem = Math.max(0, 3 - (r?.t ?? 0));
  return `<tg-emoji emoji-id="5427009714745517609">✅</tg-emoji> درخواست شما در <b><a href='https://t.me/c/2446115272/55235'>گروه سلف</a></b> ثبت شد!\nدرخواست‌های باقی‌مانده امروز: ${rem}`;
}

/* ── وضعیت ── */
async function saveState(uid, obj) {
  await DB.prepare(
    `INSERT INTO user_states(user_id,state_data,updated_at) VALUES(?,?,datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET state_data=excluded.state_data, updated_at=datetime('now')`
  ).bind(uid, JSON.stringify(obj)).run();
}
async function getState(uid) {
  const r = await DB.prepare('SELECT state_data FROM user_states WHERE user_id=?').bind(uid).first();
  if (!r?.state_data) return { state:'', data:{} };
  try { const o = JSON.parse(r.state_data); return typeof o==='object' ? o : { state:'', data:{} }; }
  catch { return { state:'', data:{} }; }
}
async function delState(uid) {
  await DB.prepare('DELETE FROM user_states WHERE user_id=?').bind(uid).run();
}

/* ── کش تکراری ── */
async function isDuplicate(key) {
  await DB.prepare("DELETE FROM request_cache WHERE created_at < datetime('now','-1 hour')").run();
  if (await DB.prepare('SELECT 1 FROM request_cache WHERE request_key=?').bind(key).first()) return true;
  await DB.prepare("INSERT INTO request_cache(request_key,created_at) VALUES(?,datetime('now'))").bind(key).run();
  return false;
}

/* ── آمار (اصلاح‌شده) ── */
async function touchUser(uid) {
  await DB.prepare(
    'INSERT OR IGNORE INTO users(user_id) VALUES(?)'
  ).bind(uid).run();

  const d = fmt('Y-m-d'), w = fmt('Y-W'), m = fmt('Y-m');
  await DB.batch([
    DB.prepare('INSERT OR IGNORE INTO user_activity(user_id,period_type,period_value) VALUES(?,?,?)').bind(uid,'daily',d),
    DB.prepare('INSERT OR IGNORE INTO user_activity(user_id,period_type,period_value) VALUES(?,?,?)').bind(uid,'weekly',w),
    DB.prepare('INSERT OR IGNORE INTO user_activity(user_id,period_type,period_value) VALUES(?,?,?)').bind(uid,'monthly',m),
  ]);
}

async function bumpRequestStats(data) {
  const d = fmt('Y-m-d'), w = fmt('Y-W'), m = fmt('Y-m');
  const ins = `INSERT INTO stats(stat_type,period_type,period_value,value) VALUES('request',?,?,1)
               ON CONFLICT(stat_type,period_type,period_value) DO UPDATE SET value=value+1`;

  const queries = [
    DB.prepare(ins).bind('total','all'),
    DB.prepare(ins).bind('daily',d),
    DB.prepare(ins).bind('weekly',w),
    DB.prepare(ins).bind('monthly',m),
  ];

  const pop = `INSERT INTO popular_items(item_type,item_name,count) VALUES(?,?,1)
               ON CONFLICT(item_type,item_name) DO UPDATE SET count=count+1`;
  if (data.dining) queries.push(DB.prepare(pop).bind('dining',data.dining));
  if (data.meal)   queries.push(DB.prepare(pop).bind('meal',data.meal));

  await DB.batch(queries);
}

async function getStats() {
  const s = {
    users:    { total:0, daily:0, weekly:0, monthly:0 },
    requests: { total:0, daily:0, weekly:0, monthly:0, deleted:0,
                popular: { dining:{}, meal:{} } }
  };

  const d = fmt('Y-m-d'), w = fmt('Y-W'), m = fmt('Y-m');

  // ── همه کوئری‌ها را یکجا اجرا کن (batch read) ──
  const [
    usersTotal,
    usersDaily,
    usersWeekly,
    usersMonthly,
    requestStats,
    deletedCount,
    popDining,
    popMeal,
  ] = await Promise.all([
    DB.prepare('SELECT COUNT(*) AS c FROM users').first(),
    DB.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM user_activity WHERE period_type='daily' AND period_value=?").bind(d).first(),
    DB.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM user_activity WHERE period_type='weekly' AND period_value=?").bind(w).first(),
    DB.prepare("SELECT COUNT(DISTINCT user_id) AS c FROM user_activity WHERE period_type='monthly' AND period_value=?").bind(m).first(),
    DB.prepare("SELECT period_type,period_value,value FROM stats WHERE stat_type='request'").all(),
    DB.prepare('SELECT COUNT(*) AS c FROM submissions WHERE deleted=1').first(),
    DB.prepare("SELECT item_name,count FROM popular_items WHERE item_type='dining' AND item_name != '' ORDER BY count DESC LIMIT 5").all(),
    DB.prepare("SELECT item_name,count FROM popular_items WHERE item_type='meal' AND item_name != '' ORDER BY count DESC LIMIT 5").all(),
  ]);

  s.users.total   = usersTotal?.c ?? 0;
  s.users.daily   = usersDaily?.c ?? 0;
  s.users.weekly  = usersWeekly?.c ?? 0;
  s.users.monthly = usersMonthly?.c ?? 0;

  for (const r of (requestStats?.results ?? [])) {
    if (r.period_type === 'total')                         s.requests.total   += r.value;
    else if (r.period_type === 'daily'   && r.period_value === d) s.requests.daily   += r.value;
    else if (r.period_type === 'weekly'  && r.period_value === w) s.requests.weekly  += r.value;
    else if (r.period_type === 'monthly' && r.period_value === m) s.requests.monthly += r.value;
  }

  s.requests.deleted = deletedCount?.c ?? 0;

  (popDining?.results ?? []).forEach(r => { s.requests.popular.dining[r.item_name] = r.count; });
  (popMeal?.results ?? []).forEach(r => { s.requests.popular.meal[r.item_name] = r.count; });

  return s;
}

async function allUsers() {
  const { results } = await DB.prepare('SELECT user_id FROM users').all();
  return results.map(r => r.user_id);
}

async function totalUsersCount() {
  return ((await DB.prepare('SELECT COUNT(*) AS c FROM users').first())?.c ?? 0).toLocaleString();
}

// ─────────────────────────────────────────────
// جریان اصلی ربات
// ─────────────────────────────────────────────

function topOf(items) {
  const keys = Object.keys(items);
  if (!keys.length) return 'بدون آمار';
  keys.sort((a,b) => items[b] - items[a]);
  return `${keys[0]} (${items[keys[0]]})`;
}

async function flowStart(uid) {
  const kb = { inline_keyboard:[[
    { 
      text: 'خرید', 
      callback_data: 'action:buy', 
      style: 'success', 
      icon_custom_emoji_id: '5431499171045581032' 
    },
    { 
      text: 'فروش', 
      callback_data: 'action:sell', 
      style: 'primary', 
      icon_custom_emoji_id: '5375296873982604963' 
    },
  ]]};
  
  await touchUser(uid);
  
  const greet = (await isAdmin(uid))
    ? "سلام ادمین جان\n\n راهنما: /help \n\n لطفا گزینه خرید یا فروش را انتخاب کنید:"
    : "لطفا گزینه خرید یا فروش را انتخاب کنید:";
    
  await sendMessage(uid, greet, kb);
  await saveState(uid, { state:'action', data:{} });
  log(uid,'START_FLOW');
}



async function flowAction(uid, action) {
  const st = await getState(uid);
  if (st.last_message_id) await deleteMsg(uid, st.last_message_id);
  const dinings = await allDinings();
  const rows = []; let row = [];
  dinings.forEach((d,i) => {
    const isHostel = d.name.includes('خوابگاه');
    row.push({ text:d.name, callback_data:`dining:${d.name}`, style: isHostel ? 'primary' : 'success' });
    if ((i+1)%3===0) { rows.push(row); row=[]; }
  });
  if (row.length) rows.push(row);
  rows.push([{ text:'🔙 بازگشت', callback_data:'back:action', style:'danger' }]);
  const mid = await sendMessage(uid, "سلف مورد نظر را انتخاب کنید:", { inline_keyboard:rows });
  st.last_message_id = mid;
  st.state = 'dining';
  st.data = { action };
  await saveState(uid, st);
  log(uid,'ACTION',action);
}


async function flowDining(uid, dining) {
  const meals = RAMADAN_MODE
    ? [{ text:'افطار 🌙', callback_data:'meal:افطار', style:'success' }, { text:'سحری 🌅', callback_data:'meal:سحری', style:'success' }]
    : [{ text:'صبحانه 🍳', callback_data:'meal:صبحانه', style:'success' }, { text:'ناهار 🍲', callback_data:'meal:ناهار', style:'success' }, { text:'شام 🍽️', callback_data:'meal:شام', style:'success' }];
  const kb = { inline_keyboard:[meals,[{ text:'🔙 بازگشت', callback_data:'back:dining', style:'danger' }]]};
  await sendMessage(uid, "وعده غذایی را انتخاب کنید:", kb);
  const st = await getState(uid);
  st.state = 'meal'; st.data.dining = dining;
  await saveState(uid, st);
  log(uid,'DINING',dining);
}

async function flowMeal(uid, meal) {
  const kb = { inline_keyboard:[
    [{ text:'شنبه', callback_data:'day:شنبه', style:'primary' }, { text:'یکشنبه', callback_data:'day:یکشنبه', style:'primary' }, { text:'دوشنبه', callback_data:'day:دوشنبه', style:'primary' }],
    [{ text:'سه‌شنبه', callback_data:'day:سه‌شنبه', style:'primary' }, { text:'چهارشنبه', callback_data:'day:چهارشنبه', style:'primary' }, { text:'پنجشنبه', callback_data:'day:پنجشنبه', style:'primary' }],
    [{ text:'جمعه', callback_data:'day:جمعه', style:'primary' }],
    [{ text:'🔙 بازگشت', callback_data:'back:meal', style:'danger' }],
  ]};
  await sendMessage(uid, "لطفاً روز مورد نظر را انتخاب کنید:", kb);
  const st = await getState(uid);
  st.state='day'; st.data.meal=meal;
  await saveState(uid,st);
  log(uid,'MEAL',meal);
}


async function postToGroup(data, uid) {
  const uname = data.username ?? `آی دی کاربر: ${uid}`;
  const key = await sha256(`${uid}${data.action}${data.dining}${data.meal}${data.day}${fmt('Y-m-d H')}`);
  if (await isDuplicate(key)) {
    await sendMessage(uid,"⚠️ شما قبلاً درخواستی با همین مشخصات ثبت کرده‌اید!");
    return false;
  }

  const txt = `<tg-emoji emoji-id="4992621764719674107">📣</tg-emoji> درخواست جدید!\nنوع درخواست: ${data.action==='buy'?'خرید':'فروش'}\nسلف: ${data.dining}\nوعده: ${data.meal}\nروز: ${data.day}\nدر صورت انصراف، درخواست را حذف کنید.`;
  
  const mid = await sendToTopic(GROUP_ID, TOPIC_ID, txt,
    { inline_keyboard:[[{ text:'ارتباط با دانشجو', url:`https://t.me/${uname}`, style:'primary' }]]});
    
  if (mid) {
    await editMarkup(GROUP_ID, mid, { inline_keyboard:[[
      { text:'ارتباط با دانشجو', url:`https://t.me/${uname}`, style:'primary' },
      { 
        text: 'حذف', 
        callback_data: `delete:${mid}:${uid}`, 
        style: 'danger', 
        icon_custom_emoji_id: '5465665476971471368' 
      },
    ]]});
  }

  log(uid,'POSTED',JSON.stringify(data));
  await bumpRequestStats(data);
  return true;
}


// ─────────────────────────────────────────────
// پنل ادمین
// ─────────────────────────────────────────────

async function adminPanel(uid) {
  const s = await getStats();
  const msg = `📊 آمار ربات:\n\n`
    + `👥 کاربران:\n• کل: ${s.users.total}\n• امروز: ${s.users.daily}\n• هفته: ${s.users.weekly}\n• ماه: ${s.users.monthly}\n\n`
    + `📨 درخواستها:\n• کل: ${s.requests.total}\n• امروز: ${s.requests.daily}\n• هفته: ${s.requests.weekly}\n• ماه: ${s.requests.monthly}\n• حذف‌شده: ${s.requests.deleted}\n\n`
    + `🏆 محبوب‌ترین‌ها:\n• سلف: ${topOf(s.requests.popular.dining)}\n• وعده: ${topOf(s.requests.popular.meal)}`;

  await sendMessage(uid, msg, { inline_keyboard:[
    [{ text:'بروزرسانی 🔄', callback_data:'admin:refresh'},{ text:'پیام همگانی 📢', callback_data:'admin:broadcast'}],
    [{ text:'مدیریت ادمین‌ها 👤', callback_data:'admin:manage'}],
    [{ text:'مدیریت سلف‌ها 🏢', callback_data:'admin:dining_manage'}],
    [{ text:'خروج ❌', callback_data:'admin:exit'}],
  ]});
}

async function adminManage(uid) {
  const a = await allAdmins();
  let txt = "🔧 مدیریت ادمین‌ها\n\n";
  for (const [id,u] of Object.entries(a)) txt += `👤 ${u} (ID: ${id})\n`;
  await sendMessage(uid, txt, { inline_keyboard:[
    [{ text:'➕ افزودن', callback_data:'admin:add'}],
    [{ text:'➖ حذف', callback_data:'admin:remove'}],
    [{ text:'🔙 بازگشت', callback_data:'admin:back', style:'danger'}],
  ]});
}

async function adminAddPrompt(uid) {
  const st = await getState(uid);
  if (st?.last_message_id) await deleteMsg(uid, st.last_message_id);
  const mid = await sendMessage(uid,"لطفا آیدی عددی کاربر را ارسال کنید:");
  await saveState(uid,{ state:'admin_add', last_message_id:mid, data:{} });
}

async function adminRemoveList(uid) {
  const a = await allAdmins();
  const kb = { inline_keyboard:[] };
  for (const [id,u] of Object.entries(a))
    kb.inline_keyboard.push([{ text:`${u} (${id})`, callback_data:`admin:delete:${id}` }]);
  kb.inline_keyboard.push([{ text:'🔙 بازگشت', callback_data:'admin:back', style:'danger' }]);
  await sendMessage(uid,"ادمین مورد نظر را انتخاب کنید:", kb);
}

async function diningManage(uid) {
  await sendMessage(uid,"مدیریت سلف‌ها:", { inline_keyboard:[
    [{ text:'➕ افزودن سلف', callback_data:'admin:dining_add'}],
    [{ text:'➖ حذف سلف', callback_data:'admin:dining_remove'}],
    [{ text:'🔙 بازگشت', callback_data:'admin:back', style:'danger'}],
  ]});
}

async function diningAddPrompt(uid) {
  await sendMessage(uid,"لطفا نام سلف جدید را وارد کنید:");
  await saveState(uid,{ state:'admin_dining_add', data:{} });
}

async function diningRemoveList(uid) {
  const ds = await allDinings();
  if (!ds.length) { await sendMessage(uid,"هیچ سلفی وجود ندارد."); return; }
  const kb = { inline_keyboard:[] };
  ds.forEach(d => kb.inline_keyboard.push([{ text:d.name, callback_data:`admin:dining_delete:${d.id}` }]));
  kb.inline_keyboard.push([{ text:'🔙 بازگشت', callback_data:'admin:back', style:'danger' }]);
  await sendMessage(uid,"سلف مورد نظر را انتخاب کنید:", kb);
}

// ─────────────────────────────────────────────
// 🔧 ارسال همگانی اصلاح‌شده با waitUntil
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// 🔧 ارسال همگانی پیشرفته (نسخه ۲.۰)
// ─────────────────────────────────────────────

async function broadcastPrompt(uid) {
  await saveState(uid, { state: 'broadcast_input' });
  await sendMessage(uid, "📝 پیام خود را ارسال کنید (متن، عکس، ویدیو، و...):\n\n• هر چیزی بفرستید عیناً برای همه ارسال می‌شود.\n• کپشن و فرمت‌ها حفظ می‌شوند.\n• /cancel برای لغو");
}

async function doBroadcast(adminId) {
  const st = await getState(adminId);
  const msgData = st?.data?.message_copy; // کل دیتای پیام ذخیره شده

  if (!msgData) {
    await sendMessage(adminId, "❌ دیتای پیام یافت نشد!");
    return;
  }

  const users = await allUsers();
  const total = users.length;
  const startTime = Date.now();

  let sentCount = 0;
  let blockCount = 0;
  let failCount = 0;

  // پیام وضعیت اولیه
  const statusMid = await sendMessage(adminId, `🚀 آغاز ارسال به ${total} کاربر...`);

  // تعیین متد و پیلود پایه براساس نوع پیام
  let method = 'sendMessage';
  let basePayload = {};

  if (msgData.text) {
    method = 'sendMessage';
    basePayload = { text: msgData.text, parse_mode: 'HTML' }; // یا entities اگر کپی کردید
  } else if (msgData.photo) {
    method = 'sendPhoto';
    basePayload = { photo: msgData.photo[0].file_id, caption: msgData.caption, parse_mode: 'HTML' };
  } else if (msgData.video) {
    method = 'sendVideo';
    basePayload = { video: msgData.video.file_id, caption: msgData.caption, parse_mode: 'HTML' };
  } else if (msgData.voice) {
    method = 'sendVoice';
    basePayload = { voice: msgData.voice.file_id, caption: msgData.caption, parse_mode: 'HTML' };
  } else if (msgData.document) {
    method = 'sendDocument';
    basePayload = { document: msgData.document.file_id, caption: msgData.caption, parse_mode: 'HTML' };
  } else if (msgData.sticker) {
    method = 'sendSticker';
    basePayload = { sticker: msgData.sticker.file_id };
  }
  
  // اگر دکمه شیشه‌ای هم داشت (اختیاری: اینجا ساده گرفتیم و دکمه‌های پیام اصلی را کپی نکردیم، 
  // ولی می‌توان reply_markup را هم از msgData کپی کرد اگر نیاز بود)

  // حلقه ارسال دسته‌ای
  for (let i = 0; i < total; i += BROADCAST_BATCH) {
    const batch = users.slice(i, i + BROADCAST_BATCH);
    
    // ارسال موازی دسته فعلی
    const results = await Promise.all(batch.map(uid => 
      safeSend(method, { chat_id: uid, ...basePayload })
    ));

    // پردازش نتایج دسته
    for (const res of results) {
      if (res.ok) sentCount++;
      else if (res.error === 'blocked') {
        blockCount++;
        // حذف کاربر بلاک‌کننده از دیتابیس (اختیاری ولی پیشنهادی)
        // await DB.prepare('DELETE FROM users WHERE user_id=?').bind(res.uid).run();
      } else {
        failCount++;
      }
    }

    // آپدیت وضعیت هر ۵۰ پیام (یا هر ۲ بچ) برای جلوگیری از اسپم ادیت
    if ((i + BROADCAST_BATCH) % 50 === 0 || i + BROADCAST_BATCH >= total) {
      const percent = Math.min(100, Math.round(((i + batch.length) / total) * 100));
      const elapsed = (Date.now() - startTime) / 1000;
      const rate = (sentCount + blockCount + failCount) / elapsed; // سرعت پردازش
      const remaining = rate > 0 ? (total - (i + batch.length)) / rate : 0;

      const statusText = `📊 <b>وضعیت ارسال همگانی</b>\n\n` +
        `${getProgressBar(percent)} ${percent}%\n\n` +
        `✅ موفق: ${sentCount}\n` +
        `🚫 بلاک/غیرفعال: ${blockCount}\n` +
        `❌ ناموفق: ${failCount}\n` +
        `👥 کل: ${total}\n\n` +
        `⏱ زمان گذشته: ${formatTime(elapsed)}\n` +
        `⏳ زمان تقریبی مانده: ${formatTime(remaining)}`;

      await editText(adminId, statusMid, statusText).catch(() => {});
    }

    // تاخیر بین دسته‌ها برای رعایت لیمیت کلی
    if (i + BROADCAST_BATCH < total) await sleep(BROADCAST_DELAY);
  }

  // گزارش نهایی
  const finalReport = `✅ <b>پایان ارسال همگانی</b>\n\n` +
    `✅ موفق: ${sentCount}\n` +
    `🚫 بلاک/غیرفعال (حذف شدند): ${blockCount}\n` +
    `❌ ناموفق: ${failCount}\n` +
    `👥 کل مخاطبین: ${total}\n` +
    `⏱ زمان کل: ${formatTime((Date.now() - startTime) / 1000)}`;

  // حذف پیام وضعیت و ارسال گزارش جدید (یا ادیت همان)
  await deleteMsg(adminId, statusMid);
  await sendMessage(adminId, finalReport);
  await delState(adminId);
}


// ─────────────────────────────────────────────
// هندلر اصلی
// ─────────────────────────────────────────────
async function handle(update) {

  /* ═══════ CALLBACK QUERY ═══════ */
  if (update.callback_query) {
    const cq    = update.callback_query;
    const uid   = cq.from.id;
    const mid   = cq.message.message_id;
    const cid   = cq.message.chat.id;
    const parts = cq.data.split(':');
    const act   = parts[0];
    const val   = parts.slice(1).join(':');

    log(uid,'BTN',cq.data);

    if (!['delete','check_subscription'].includes(act)) await deleteMsg(cid, mid);

    switch (act) {

      case 'delete': {
        const [tmid, pid] = val.split(':');
        if (!tmid || !pid) { await sendMessage(uid,"⚠️ خطا!"); break; }
        if (uid !== Number(pid)) { await sendMessage(uid,"⚠️ مجوز ندارید!"); break; }
        const r = await tg('deleteMessage',{ chat_id:GROUP_ID, message_id:Number(tmid) });
        if (!r?.ok) { await sendMessage(uid,"❌ خطا در حذف!"); break; }
        const today = fmt('Y-m-d');
        await DB.prepare('UPDATE submissions SET deleted=1 WHERE user_id=? AND submission_date=? AND deleted=0')
          .bind(Number(pid),today).run();
        await sendMessage(uid,`<tg-emoji emoji-id="5427009714745517609">✅</tg-emoji> پیام حذف شد.`);
        break;
      }

      case 'check_subscription': {
        if (await isMember(uid, REQUIRED_CHANNEL)) { await flowStart(uid); }
        else {
          const link = `https://t.me/${REQUIRED_CHANNEL.slice(1)}`;
          await sendMessage(uid,
            `❌ هنوز عضو نشدید!\n\n<a href='${link}'>${REQUIRED_CHANNEL}</a>`,
            { inline_keyboard:[[{ text:'بررسی عضویت', callback_data:'check_subscription' }]]});
        }
        break;
      }

      case 'back': {
        const st = await getState(uid);
        if (val==='action')      await flowStart(uid);
        else if (val==='dining') await flowAction(uid, st.data?.action ?? '');
        else if (val==='meal')   await flowDining(uid, st.data?.dining ?? '');
        else await sendMessage(uid,"⚠️ خطا!");
        break;
      }

      case 'action':  await flowAction(uid, val);  break;
      case 'dining':  await flowDining(uid, val);  break;
      case 'meal':    await flowMeal(uid, val);    break;

      case 'day': {
        const adm = await isAdmin(uid);
        if (!adm && !(await canSubmit(uid))) {
          const today = fmt('Y-m-d');
          const r = await DB.prepare(
            'SELECT SUM(count) AS t FROM submissions WHERE user_id=? AND submission_date=? AND deleted=0'
          ).bind(uid,today).first();
          await sendMessage(uid,`⚠️ شما امروز ${r?.t??0} درخواست ارسال کرده‌اید!\nحداکثر ۳ درخواست مجاز است.`);
          await delState(uid);
          break;
        }
        const st = await getState(uid);
        st.data.day = val;
        st.data.username = cq.from.username ?? null;
        if (!st.data.username) {
          await sendMessage(uid,"⚠️ باید یوزرنیم داشته باشید!");
        } else {
          const ok = await postToGroup(st.data, uid);
          if (ok) {
            if (!adm) await addSubmission(uid);
            await sendMessage(uid, await remainingMsg(uid));
          }
        }
        await delState(uid);
        break;
      }

      case 'admin': {
        if (!(await isAdmin(uid))) { await sendMessage(uid,"⛔️ دسترسی غیرمجاز!"); break; }
        const sub   = val.split(':')[0];
        const param = val.split(':').slice(1).join(':');

        if (sub==='refresh')        await adminPanel(uid);
        else if (sub==='broadcast') await broadcastPrompt(uid);
        else if (sub==='exit')      { /* حذف شده */ }
        else if (sub==='manage')    await adminManage(uid);
        else if (sub==='add')       await adminAddPrompt(uid);
        else if (sub==='remove')    await adminRemoveList(uid);
        else if (sub==='delete') {
          if (await removeAdmin(Number(param))) await sendMessage(uid,"✅ ادمین حذف شد.");
          else await sendMessage(uid,"❌ خطا!");
          await adminManage(uid);
        }
        else if (sub==='dining_manage')  await diningManage(uid);
        else if (sub==='dining_add')     await diningAddPrompt(uid);
        else if (sub==='dining_remove')  await diningRemoveList(uid);
        else if (sub==='dining_delete') {
          const did = Number(param);
          if (did > 0 && await removeDining(did)) await sendMessage(uid,"✅ سلف حذف شد.");
          else await sendMessage(uid,"❌ خطا!");
          await diningManage(uid);
        }
        else if (sub==='back') await adminPanel(uid);
        break;
      }

      // ── ارسال همگانی: اصلاح‌شده با waitUntil ──
      case 'broadcast': {
        if (!(await isAdmin(uid))) { await sendMessage(uid,"⛔️ دسترسی غیرمجاز!"); break; }
        if (val==='confirm') {
          // پاسخ سریع به کاربر، سپس ارسال در پس‌زمینه
          await sendMessage(uid,"⏳ ارسال همگانی شروع شد...");

          // waitUntil اجازه می‌دهد بعد از Response هم کار ادامه پیدا کند
          CTX.waitUntil(doBroadcast(uid));

        } else if (val==='cancel') {
          await delState(uid);
          await sendMessage(uid,"❌ لغو شد.");
        }
        break;
      }

      default: await sendMessage(uid,"⚠️ اقدام نامعتبر!"); break;
    }

    await tg('answerCallbackQuery',{ callback_query_id:cq.id });
    return;
  }

  /* ═══════ MESSAGE ═══════ */
  if (update.message) {
    const msg  = update.message;
    const uid  = msg.from.id;
    const text = msg.text ?? '';
    const st   = await getState(uid);

    if (st.state === 'broadcast_input') {
      if (text && text.toLowerCase() === '/cancel') {
        await delState(uid);
        await sendMessage(uid, "❌ لغو شد.");
        return;
      }

      const msgCopy = {};
      
      if (msg.text) {
        msgCopy.text = msg.text; // اگر HTML بود و entities داشت پیچیده‌تر است، اینجا فرض بر متن ساده یا HTML دستی است
      } else if (msg.photo) {
        msgCopy.photo = msg.photo; // آرایه سایزها
        msgCopy.caption = msg.caption;
      } else if (msg.video) {
        msgCopy.video = msg.video;
        msgCopy.caption = msg.caption;
      } else if (msg.voice) {
        msgCopy.voice = msg.voice;
        msgCopy.caption = msg.caption;
      } else if (msg.document) {
        msgCopy.document = msg.document;
        msgCopy.caption = msg.caption;
      } else if (msg.sticker) {
        msgCopy.sticker = msg.sticker;
      } else {
         await sendMessage(uid, "⚠️ این نوع پیام پشتیبانی نمی‌شود.");
         return;
      }

      // نمایش پیش‌نمایش (با متد کپی)
      // ترفند: برای پیش‌نمایش دقیق، همان پیام را به ادمین copyMessage می‌کنیم
      const copyRes = await tg('copyMessage', {
        chat_id: uid,
        from_chat_id: uid,
        message_id: msg.message_id
      });
      
      const pmid = copyRes.result.message_id;

      await saveState(uid, { 
        state: 'broadcast_confirm', 
        data: { message_copy: msgCopy } // ذخیره دیتای پیام برای استفاده در doBroadcast
      });

      // ارسال منوی تایید زیر پیام کپی شده (یا به عنوان پیام جدا)
      // چون copyMessage کیبورد ندارد، یک پیام جداگانه برای منو می‌فرستیم
      await sendMessage(uid, "👆 پیش‌نمایش پیام فوق برای همه ارسال می‌شود.\nتایید می‌کنید؟", {
        inline_keyboard: [[
          { text: '✅ تایید و ارسال', callback_data: 'broadcast:confirm' },
          { text: '❌ لغو', callback_data: 'broadcast:cancel' }
        ]]
      });
      
      return;
    }

    if (st.state === 'admin_dining_add') {
      const name = text.trim();
      if (!name) { await sendMessage(uid,"نام نمیتواند خالی باشد!"); return; }
      if (await addDining(uid,name)) await sendMessage(uid,`✅ سلف اضافه شد: ${name}`);
      else await sendMessage(uid,"❌ خطا! شاید تکراری باشد.");
      await delState(uid);
      await diningManage(uid);
      return;
    }

    if (st.state === 'admin_add') {
      if (!/^\d+$/.test(text)) { await sendMessage(uid,"⚠️ آیدی باید عددی باشد!"); return; }
      const tid = Number(text);
      if (tid <= 0) { await sendMessage(uid,"⚠️ آیدی نامعتبر!"); return; }
      const uname = await fetchUsername(tid);
      if (!uname) { await sendMessage(uid,"❌ کاربر یافت نشد!"); return; }
      if (await addAdmin(uid, tid, uname)) await sendMessage(uid,`✅ ادمین اضافه شد: @${uname} (${tid})`);
      else await sendMessage(uid,"❌ خطا یا تکراری!");
      await delState(uid);
      await adminManage(uid);
      return;
    }

    if (text === '/start') {
      if (!msg.from.username) {
        await sendMessage(uid,"⚠️ باید یوزرنیم داشته باشید!\nاز تنظیمات تلگرام یوزرنیم تعیین کنید.");
        return;
      }
      if (!(await isMember(uid, REQUIRED_CHANNEL))) {
        const link = `https://t.me/${REQUIRED_CHANNEL.slice(1)}`;
        await sendMessage(uid,
          `❗️ ابتدا در کانال عضو شوید:\n<a href='${link}'>${REQUIRED_CHANNEL}</a>\n\nسپس «بررسی عضویت» بزنید:`,
          { inline_keyboard:[[{ text:'بررسی عضویت', callback_data:'check_subscription' }]]});
        return;
      }
      await flowStart(uid);
      return;
    }

    if (text === '/help') {
      await sendMessage(uid,
        "📚 راهنما:\n\n• /start — شروع خرید/فروش\n• هر روز ۳ درخواست\n• ادمین: @amposhtiban\n• گروه: @semnanm\n• کانال: @semnanam\n\n🧡");
      return;
    }

    if (text === '/admin') {
      if (await isAdmin(uid)) await adminPanel(uid);
      else await sendMessage(uid,"⛔️ دسترسی غیرمجاز!");
      return;
    }
  }
}

// ─────────────────────────────────────────────
// نقطه ورود ورکر
// ─────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {   // ← ctx اضافه شد
    DB        = env.DB;
    BOT_TOKEN = env.BOT_TOKEN;
    CTX       = ctx;                 // ← ذخیره context

    if (request.method === 'POST') {
      try {
        const update = await request.json();
        await handle(update);
      } catch (e) {
        console.error('Update error:', e.stack ?? e);
      }
    }
    return new Response('OK');
  },
};