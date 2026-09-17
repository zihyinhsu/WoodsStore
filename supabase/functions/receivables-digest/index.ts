// ============================================================
// 每日追款提醒信
//
// 由 pg_cron 每天呼叫一次，查出「已逾期」與「今天到期」的未收款項，
// 組成一封摘要信寄給負責追款的人。
//
// 為什麼是 email 而不是日曆或推播：
//   - 日曆訂閱 feed：Google 對「訂閱的其他日曆」多半不發通知，會退化成看得到但不提醒；
//     且訂閱端不帶 JWT，應收資料只能靠難猜的網址保護。
//   - FCM 推播：要 Firebase、Service Worker、裝置 token 表，iOS 還得先安裝成 PWA。
//   - Email 每台裝置都收得到、不必安裝任何東西，發送端只是一次 fetch。
//
// 真正的核心是排程而非通道：日後要換成 LINE 或推播，只需改下面 sendEmail 那一段。
//
// 部署（不走 Vercel，Vercel 只部署前端靜態產物）：
//   supabase functions deploy receivables-digest --no-verify-jwt
//
// --no-verify-jwt 是必要的：呼叫方是 pg_cron，不帶使用者 JWT，
// 預設的 JWT 驗證會讓排程一律吃 401。改以自訂的 X-Digest-Token 驗證。
// ============================================================
import { createClient } from 'jsr:@supabase/supabase-js@2';

// 這兩把鑰匙只存在 Edge Function 環境，絕不可進前端產物（VITE_ 開頭的變數瀏覽器可見）。
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!;
const DIGEST_TOKEN = Deno.env.get('DIGEST_TOKEN')!;
const DIGEST_FROM = Deno.env.get('DIGEST_FROM')!;
const DIGEST_RECIPIENTS = Deno.env.get('DIGEST_RECIPIENTS')!;

// 前端 js/utils.js 有同名函式，但那是瀏覽器端的 ES module，
// Edge Function 以 supabase/functions 為部署根目錄、無法 import 專案外的檔案，
// 因此這裡重寫一份。改動時兩邊要一起看。
function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]!));
}

function formatCurrency(amount: unknown): string {
  return new Intl.NumberFormat('zh-TW', {
    style: 'currency', currency: 'TWD',
    minimumFractionDigits: 0, maximumFractionDigits: 0
  }).format(Number(amount) || 0);
}

// 一律以台北時區判讀日期：排程在台北早上執行，若用 UTC 會落在前一天。
function taipeiToday(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Taipei' }).format(new Date());
}

interface Row {
  order_id: string;
  order_no: string;
  order_date: string;
  partner_name: string | null;
  partner_phone: string | null;
  expected_payment_date: string | null;
  outstanding_amount: number;
  due_bucket: string;
  days_past_due: number | null;
}

function renderRows(rows: Row[]): string {
  return rows.map(row => `
    <tr>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(row.partner_name || '-')}</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(row.order_no)}</td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(row.expected_payment_date || '-')}</td>
      <td style="padding:8px;border:1px solid #ddd;text-align:right;font-weight:600;">
        ${escapeHtml(formatCurrency(row.outstanding_amount))}
      </td>
      <td style="padding:8px;border:1px solid #ddd;">${escapeHtml(row.partner_phone || '-')}</td>
    </tr>`).join('');
}

function buildEmailHtml(overdue: Row[], dueToday: Row[], today: string): string {
  const total = (rows: Row[]) =>
    rows.reduce((sum, r) => sum + (Number(r.outstanding_amount) || 0), 0);

  const section = (title: string, rows: Row[], color: string) => rows.length === 0 ? '' : `
    <h3 style="color:${color};margin:24px 0 8px;">${escapeHtml(title)}（${rows.length} 筆，共 ${escapeHtml(formatCurrency(total(rows)))}）</h3>
    <table style="border-collapse:collapse;width:100%;font-size:14px;">
      <thead>
        <tr style="background:#f0f0f0;">
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">客戶</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">單號</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">預計收款日</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:right;">未收金額</th>
          <th style="padding:8px;border:1px solid #ddd;text-align:left;">聯絡電話</th>
        </tr>
      </thead>
      <tbody>${renderRows(rows)}</tbody>
    </table>`;

  return `
    <div style="font-family:'Noto Sans TC',sans-serif;color:#1f1f1f;max-width:800px;">
      <h2 style="margin:0 0 4px;">藝境裝潢材料行 — 追款提醒</h2>
      <p style="color:#718096;margin:0;">${escapeHtml(today)}</p>
      ${section('已逾期', overdue, '#c53030')}
      ${section('今天到期', dueToday, '#c05621')}
      <p style="color:#718096;font-size:12px;margin-top:24px;">
        本信由系統自動寄出。金額為單據未收餘額，收款後將自動從清單移除。
      </p>
    </div>`;
}

async function sendEmail(subject: string, html: string) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: DIGEST_FROM,
      // 以逗號分隔多個收件人；去掉空白並濾掉空值，避免尾端逗號造成 422。
      to: DIGEST_RECIPIENTS.split(',').map(s => s.trim()).filter(Boolean),
      subject,
      html
    })
  });

  if (!response.ok) {
    throw new Error(`Resend 回應 ${response.status}: ${await response.text()}`);
  }
  return await response.json();
}

Deno.serve(async (req: Request) => {
  // 排程專用端點，不對外公開；token 不符一律 401。
  if (req.headers.get('X-Digest-Token') !== DIGEST_TOKEN) {
    return new Response(JSON.stringify({ error: 'unauthorized' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

    // due_bucket 已在 view 內以台北時區算好，這裡不重算「今天」，
    // 避免同一個判斷在兩處各寫一次而漂移。
    const { data, error } = await supabase
      .from('receivable_followup_view')
      .select('*')
      .in('due_bucket', ['overdue', 'today'])
      .order('expected_payment_date', { ascending: true });

    if (error) throw error;

    const rows = (data || []) as Row[];
    const overdue = rows.filter(r => r.due_bucket === 'overdue');
    const dueToday = rows.filter(r => r.due_bucket === 'today');

    // 沒有到期或逾期項目就不寄：每天一封空信會讓人養成略過的習慣，
    // 真的有事要追時反而不會被看見。
    if (rows.length === 0) {
      return new Response(JSON.stringify({ sent: false, reason: 'nothing due' }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const today = taipeiToday();
    const subject = `追款提醒 ${today}：逾期 ${overdue.length} 筆、今日到期 ${dueToday.length} 筆`;
    await sendEmail(subject, buildEmailHtml(overdue, dueToday, today));

    return new Response(
      JSON.stringify({ sent: true, overdue: overdue.length, due_today: dueToday.length }),
      { headers: { 'Content-Type': 'application/json' } }
    );
  } catch (err) {
    console.error('receivables-digest failed:', err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
});
