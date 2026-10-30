import { getDatabase } from "firebase-admin/database";
import { adminApp } from "./lib/firebaseAdmin.mjs";

const escapeHtml = (value) => String(value || "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
}[char]));

const displayDate = (value) => {
  const parts = String(value || "").split("-").map(Number);
  if (parts.length !== 3 || !parts.every(Number.isFinite)) return "날짜 미정";
  return `${String(parts[0]).slice(-2)}.${parts[1]}.${parts[2]}`;
};

function notFoundPage() {
  return {
    statusCode: 404,
    headers: { "Content-Type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>영수증을 찾을 수 없어요</title><style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f6f4;font-family:"Malgun Gothic",sans-serif;color:#1c1c1b}
.card{max-width:340px;margin:20px;padding:36px 28px;text-align:center;background:#fff;border-radius:22px;box-shadow:0 20px 60px rgba(0,0,0,.08)}
.icon{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;background:#f3f6f4;display:flex;align-items:center;justify-content:center;font-size:26px}
h1{font-size:17px;margin:0 0 8px}
p{font-size:13px;color:#6c716e;line-height:1.6;margin:0}
</style></head><body><div class="card"><div class="icon">🧾</div><h1>영수증을 찾을 수 없어요</h1><p>링크가 잘못됐거나 삭제된 영수증일 수 있어요.</p></div></body></html>`
  };
}

export const handler = async (event) => {
  const id = String(event.queryStringParameters?.id || "").replace(/[^a-zA-Z0-9_-]/g, "");
  const room = String(event.queryStringParameters?.room || "").replace(/[^a-zA-Z0-9_-]/g, "");
  if (!id) return notFoundPage();

  const snapshot = await getDatabase(adminApp()).ref(`receipts/${id}`).get();
  const receipt = snapshot.exists() ? snapshot.val() : null;
  if (!receipt || receipt.published !== true) return notFoundPage();

  if (event.queryStringParameters?.data === "1") {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=5, stale-while-revalidate=30"
      },
      body: JSON.stringify(receipt)
    };
  }

  const rawDate = receipt.mode === "budget" ? receipt.plannedDate : receipt.usedDate;
  const fallback = receipt.mode === "budget" ? "예산 영수증" : "정산 영수증";
  const title = `${displayDate(rawDate)} ${String(receipt.title || fallback).trim()}`;
  const total = Object.values(receipt.items || {}).reduce((sum, item) => sum + Number(item?.amount || 0), 0);
  const people = new Set(Object.values(receipt.items || {}).flatMap((item) => [item?.payer, ...Object.values(item?.users || {})]).filter((name) => name && name !== "공금"));
  const description = `정산금액 : ${total.toLocaleString("ko-KR")}원 · 요청인원 : ${people.size || 1}명 · 정산 내용을 확인해 주세요.`;
  const targetParams = new URLSearchParams({ id });
  if (room || receipt.roomId) targetParams.set("room", room || receipt.roomId);
  const target = `/receipt/view.html?${targetParams.toString()}`;
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeTarget = escapeHtml(target);

  return {
    statusCode: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=60" },
    body: `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeTitle}</title><meta property="og:title" content="정산을 시작했어요 · ${safeTitle}"><meta property="og:description" content="${safeDescription}"><meta property="og:image" content="https://nolgo.netlify.app/nolgo-settle-banner.png"><meta property="og:type" content="website"><meta property="og:site_name" content="놀고정산"><meta http-equiv="refresh" content="0;url=${safeTarget}"></head><body><a href="${safeTarget}">${safeTitle}</a><script>location.replace(${JSON.stringify(target)})</script></body></html>`
  };
};
