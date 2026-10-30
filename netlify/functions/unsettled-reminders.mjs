import { getDatabase } from "firebase-admin/database";
import { adminApp } from "./lib/firebaseAdmin.mjs";
import { sendToUids } from "./lib/messaging.mjs";
import { computeSettlement } from "./lib/settlement.mjs";
import { formatWon } from "./lib/format.mjs";

const DEFAULT_ROOM_ID = "room-78664b1a-5e50-4758-80b0-5645e1000e5d";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// Runs daily to check elapsed days since creation/publish date.
export const config = { schedule: "@daily" };

export default async () => {
  const db = getDatabase(adminApp());
  const now = Date.now();
  const updates = {};
  const sends = [];

  // 1. Check meetings in default room
  const roomSnap = await db.ref(`rooms/${DEFAULT_ROOM_ID}`).get();
  if (roomSnap.exists()) {
    const room = roomSnap.val();
    const meetings = room.meetings && typeof room.meetings === "object" ? room.meetings : {};

    for (const [meetingId, meeting] of Object.entries(meetings)) {
      const memberLinks = meeting?.state?.memberLinks || {};
      const { transfers } = computeSettlement(meeting);
      const createdAt = Number(meeting?.createdAt) || now;
      const daysElapsed = Math.floor((now - createdAt) / ONE_DAY_MS);

      // We send reminders at day 3, 5, and 7
      let targetStage = 0;
      let stageTitle = "";
      let stageBodyPrefix = "";

      if (daysElapsed >= 7) {
        targetStage = 7;
        stageTitle = "정산 지연 안내 (7일차)";
        stageBodyPrefix = "정산이 일주일째 완료되지 않았어요. ";
      } else if (daysElapsed >= 5) {
        targetStage = 5;
        stageTitle = "정산 요청 (5일차)";
        stageBodyPrefix = "정산 기한을 확인해 주세요. ";
      } else if (daysElapsed >= 3) {
        targetStage = 3;
        stageTitle = "미정산 알림 (3일차)";
        stageBodyPrefix = "아직 정산하지 않은 금액이 있어요. ";
      }

      if (targetStage === 0) continue;

      for (const transfer of transfers) {
        if (transfer.completed) continue;
        const uid = memberLinks[transfer.from];
        if (!uid) continue; // debtor not linked to an account yet

        const reminderRecord = meeting?.state?.unsettledReminders?.[uid]?.[transfer.key];
        const sentStages = typeof reminderRecord === "object" && reminderRecord !== null
          ? (reminderRecord.stages || {})
          : {};

        // If this specific stage was already sent, skip
        if (sentStages[targetStage]) continue;

        const body = `${stageBodyPrefix}${transfer.to}님에게 아직 ${formatWon(transfer.amount)}을 보내지 않았어요.`;
        sends.push(sendToUids([uid], stageTitle, body));

        updates[`rooms/${DEFAULT_ROOM_ID}/meetings/${meetingId}/state/unsettledReminders/${uid}/${transfer.key}/stages/${targetStage}`] = now;
        updates[`rooms/${DEFAULT_ROOM_ID}/meetings/${meetingId}/state/unsettledReminders/${uid}/${transfer.key}/lastSentAt`] = now;
      }
    }
  }

  // 2. Also check independent receipts for unsettled transfers
  const receiptsSnap = await db.ref("receipts").get();
  if (receiptsSnap.exists()) {
    const receipts = receiptsSnap.val();
    for (const [receiptId, receipt] of Object.entries(receipts)) {
      if (!receipt || receipt.mode === "budget" || !receipt.items) continue;

      const createdAt = Number(receipt.createdAt) || (receipt.usedDate ? new Date(`${receipt.usedDate}T00:00:00`).getTime() : now);
      const daysElapsed = Math.floor((now - createdAt) / ONE_DAY_MS);

      let targetStage = 0;
      let stageTitle = "";
      let stageBodyPrefix = "";

      if (daysElapsed >= 7) {
        targetStage = 7;
        stageTitle = "영수증 정산 지연 안내 (7일차)";
        stageBodyPrefix = "정산이 일주일째 완료되지 않았어요. ";
      } else if (daysElapsed >= 5) {
        targetStage = 5;
        stageTitle = "영수증 정산 요청 (5일차)";
        stageBodyPrefix = "정산 기한을 확인해 주세요. ";
      } else if (daysElapsed >= 3) {
        targetStage = 3;
        stageTitle = "영수증 미정산 알림 (3일차)";
        stageBodyPrefix = "아직 정산하지 않은 금액이 있어요. ";
      }

      if (targetStage === 0) continue;

      const completedTransfers = receipt.completedTransfers || {};
      const items = Array.isArray(receipt.items) ? receipt.items : Object.values(receipt.items);
      const receiptTitle = receipt.title || "영수증";

      for (const item of items) {
        const payer = item.payer;
        const users = item.users || [];
        if (!payer || payer === "공금" || users.length === 0) continue;
        const share = Math.round(Number(item.amount || 0) / users.length);

        for (const user of users) {
          if (user === payer) continue;
          const transferKey = `${user}@@${payer}`;
          if (completedTransfers[transferKey]) continue;

          // Look up user UID by checking room memberLinks
          const roomSnap = await db.ref(`rooms/${receipt.roomId || DEFAULT_ROOM_ID}`).get();
          const room = roomSnap.val();
          const meetings = room?.meetings || {};
          let targetUid = null;
          for (const m of Object.values(meetings)) {
            if (m?.state?.memberLinks?.[user]) {
              targetUid = m.state.memberLinks[user];
              break;
            }
          }
          if (!targetUid) continue;

          const reminderRecord = receipt.unsettledReminders?.[targetUid]?.[transferKey];
          const sentStages = typeof reminderRecord === "object" && reminderRecord !== null
            ? (reminderRecord.stages || {})
            : {};

          if (sentStages[targetStage]) continue;

          const body = `${stageBodyPrefix}'${receiptTitle}' 정산: ${payer}님에게 ${formatWon(share)}을 송금해 주세요.`;
          sends.push(sendToUids([targetUid], stageTitle, body));

          updates[`receipts/${receiptId}/unsettledReminders/${targetUid}/${transferKey}/stages/${targetStage}`] = now;
          updates[`receipts/${receiptId}/unsettledReminders/${targetUid}/${transferKey}/lastSentAt`] = now;
        }
      }
    }
  }

  await Promise.all(sends);
  if (Object.keys(updates).length > 0) await db.ref().update(updates);

  return new Response(JSON.stringify({ ok: true, sentCount: sends.length }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
};
