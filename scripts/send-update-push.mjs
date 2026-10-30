import { initializeApp, cert } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";
import { getMessaging } from "firebase-admin/messaging";
import { execSync } from "child_process";

// Fetch service account from Netlify env
const raw = execSync("npx netlify env:get FIREBASE_SERVICE_ACCOUNT_JSON", {
  encoding: "utf8",
  cwd: new URL("..", import.meta.url),
});
const jsonMatch = raw.slice(raw.indexOf("{"));
const serviceAccount = JSON.parse(jsonMatch);

const app = initializeApp({
  credential: cert(serviceAccount),
  databaseURL: "https://nolgo-jeongsan-default-rtdb.firebaseio.com",
});

const db = getDatabase(app);
const messaging = getMessaging(app);

async function sendUpdatePush() {
  console.log("Fetching registered user tokens...");
  const usersSnap = await db.ref("users").get();
  if (!usersSnap.exists()) {
    console.log("No users found");
    return;
  }

  const rawTokens = [];
  usersSnap.forEach((userSnap) => {
    const fcmTokens = userSnap.child("fcmTokens").val();
    if (fcmTokens) rawTokens.push(...Object.keys(fcmTokens));
  });

  const tokens = [...new Set(rawTokens)];
  console.log(`Found ${tokens.length} unique device token(s)`);
  if (tokens.length === 0) {
    console.log("No devices to send push");
    return;
  }

  const response = await messaging.sendEachForMulticast({
    tokens,
    notification: {
      title: "놀고정산 v1.9.5 업데이트 안내",
      body: "스켈레톤 로딩, 쫀득한 스프링 터치감, D-day 리마인더 배너가 적용되었어요!",
    },
    data: {
      type: "update",
      versionCode: "15",
      versionName: "1.9.5",
    },
  });

  console.log(`Successfully sent: ${response.successCount}, Failed: ${response.failureCount}`);
  response.responses.forEach((r, i) => {
    if (!r.success) {
      console.error(`Token ${tokens[i]} failed:`, r.error?.message);
    }
  });
}

sendUpdatePush().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});
